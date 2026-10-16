import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { fetchUsage, type ProbeResult } from './client.ts'
import { listCandidateSites, resolveCurrentSite, type CredentialSource, type SiteCredential } from './config.ts'
import { formatDetail, formatFooter, formatPrimary, type Palette } from './format.ts'
import { normalize, type NormalizedUsage } from './normalize.ts'
import { notify, setFooter } from './ui.ts'

export interface RefresherDeps {
  resolveSite: (ctx?: ExtensionContext) => Promise<SiteCredential | undefined>
  listSites: (ctx?: ExtensionContext) => Promise<SiteCredential[]>
  fetchImpl?: typeof fetch
  /** Footer palette. Required, so the wiring site must decide explicitly (live theme under TUI, PLAIN_PALETTE elsewhere). */
  palette: Palette
  setStatus: (text: string | undefined, link?: string) => void
  timeoutMs?: number
  /**
   * Minimum spacing between two dispatched requests. Turn-by-turn refreshes are throttled by
   * this so that a long run cannot turn into one gateway request per turn. A forced refresh
   * ignores it.
   */
  minIntervalMs?: number
  /** Lets tests inject a fixed clock for reset countdowns and relative times; defaults to Date.now. */
  now?: () => number
}

export interface Refresher {
  refresh(options?: { force?: boolean; timeoutMs?: number }): Promise<void>
  describe(): Promise<string>
  reset(): void
  /**
   * Drops the session's cached probe verdicts. Deliberately separate from `reset()`: that one
   * also runs on a model switch, while which providers Pi has configured has nothing to do
   * with the current model.
   */
  resetCandidates(): void
}

/** The outcome of the last refresh. `describe()` picks its wording from this, not from whether a cached value happens to exist. */
type RefreshOutcome =
  | { kind: 'ok' }
  | { kind: 'not-sub2api' }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'network-error'; message: string }

function minutesAgo(fetchedAt: number, now: number): number {
  return Math.max(0, Math.round((now - fetchedAt) / 60_000))
}

/**
 * Identity of a candidate in the probe cache: where the probe would send the request and which
 * key it would present, which together are what its verdict is a fact about.
 *
 * Keying on the provider alone would be wrong twice over: rotating a key must re-check that
 * provider instead of leaving it condemned, and changing its `baseUrl` must point the probe at
 * the new endpoint instead of reusing the old one's answer.
 */
function candidateKey(candidate: SiteCredential): string {
  return `${candidate.provider}\u0000${candidate.usageUrl}\u0000${candidate.fingerprint}`
}

/**
 * How long a turn-by-turn refresh is suppressed for.
 *
 * One prompt can run for many minutes and emits a `turn_end` roughly every 11s, while
 * `agent_settled` fires only once at the very end. Refreshing on every turn would put one
 * request per turn on the gateway for no new information, so the cheap path is throttled
 * to about two per minute — still fast enough to watch the spend climb.
 */
const DEFAULT_MIN_INTERVAL_MS = 30_000

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Header for a key Pi's config still offers but the gateway rejected. One constant for both
 * `describe()` paths, because an invalid key is a fact we know whether or not a balance was
 * ever cached, and the two paths must not word it differently.
 */
const INVALID_KEY_HEADER = 'API key is invalid or has expired.'

/**
 * Refresh orchestration. **The promise returned by `refresh()` never rejects** — it is
 * called fire-and-forget, and an unhandled rejection would terminate the whole session
 * via unhandledRejection.
 */
export function createRefresher(deps: RefresherDeps): Refresher {
  let last: { site: SiteCredential; usage: NormalizedUsage } | undefined
  let outcome: RefreshOutcome | undefined
  let inFlight: Promise<void> | undefined
  /** When the last request was dispatched. Starts at -Infinity so the very first refresh is never throttled. */
  let lastDispatchAt = Number.NEGATIVE_INFINITY
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS

  /**
   * Verdicts from the second-tier probe, for this session only.
   *
   * `/sub2-usage` is a manual command, and every call used to re-probe every configured
   * provider — including the ones already known to be dead ends, at up to 5s each. The spec
   * asks for negative results to be cached within the session. Only negatives are stored: a
   * balance moves between two calls, but "this endpoint is not sub2api" does not.
   */
  const candidateVerdicts = new Map<string, Exclude<ProbeResult, { kind: 'ok' }>>()

  /**
   * Generation counter. `reset()` increments it, which expires any **in-flight** refresh.
   *
   * Without it, two real failures appear: after a model switch the previous site's slow
   * response lands and writes the wrong balance into the new model's footer; and when
   * the old request finishes it unconditionally clears `inFlight`, wiping the new
   * request's concurrency dedup along with it (the spec allows exactly one request in
   * flight at a time).
   */
  let generation = 0

  const now = (): number => deps.now?.() ?? Date.now()

  const status = (text: string | undefined, link?: string): void => {
    try {
      deps.setStatus(text, link)
    } catch {
      /* A UI failure must not affect the refresh flow */
    }
  }

  const applyFailure = (message: string, link?: string): void => {
    // `unauthorized` outranks a network error. It is a fact obtained from a completed HTTP
    // exchange, while a network error is an absence of information: letting the second
    // overwrite the first would downgrade "your API key is invalid" into an old balance
    // prefixed with `~`, which looks like a temporary blip, and would hide the one thing
    // the user can actually act on. It stays until a successful refresh or reset() clears
    // it — reset() drops `outcome`, which is where the stickiness lives.
    //
    // The cached usage is deliberately kept on this path, so `/sub2-usage` can still show
    // the numbers under the invalid-key header instead of degrading to a bare error.
    if (outcome?.kind === 'unauthorized') return

    outcome = { kind: 'network-error', message }
    // With a cached value the footer still points at a known site; without one there is no link to give.
    const footer = formatFooter({ kind: 'error', usage: last?.usage ?? null }, deps.palette, now())
    status(footer, link ?? last?.site.baseUrl)
  }

  async function run(gen: number, timeoutMs?: number): Promise<void> {
    const site = await deps.resolveSite()
    if (gen !== generation) return

    if (!site) {
      last = undefined
      outcome = { kind: 'not-sub2api' }
      status('')
      return
    }

    const result = await fetchUsage(site, {
      fetchImpl: deps.fetchImpl,
      timeoutMs: timeoutMs ?? deps.timeoutMs,
    })
    // The critical gate: a stale request must not touch any state, footer included.
    if (gen !== generation) return

    switch (result.kind) {
      case 'ok': {
        // No guard around normalize(): the probe only reports `ok` for a body that passed
        // `isSub2ApiPayload`, which is the same whitelist normalize() enforces. Were that
        // invariant ever to break, the failure now surfaces as an error instead of being
        // quietly reported as "this site is not sub2api".
        const usage = normalize(result.body)
        last = { site, usage }
        outcome = { kind: 'ok' }
        status(formatFooter({ kind: 'ok', usage, stale: false }, deps.palette, now()), site.baseUrl)
        return
      }

      case 'not-sub2api':
        // The site is no longer sub2api, so the cached value is no longer trustworthy and must be dropped.
        last = undefined
        outcome = { kind: 'not-sub2api' }
        status('')
        return

      case 'unauthorized':
        // Sticky: see applyFailure(). `last` is kept on purpose, so the detail view still has
        // the numbers to show beneath the invalid-key header.
        outcome = { kind: 'unauthorized', message: result.message }
        status(formatFooter({ kind: 'unauthorized' }, deps.palette, now()), site.baseUrl)
        return

      case 'network-error':
        applyFailure(result.message, site.baseUrl)
        return
    }
  }

  function describeHeader(): string | undefined {
    if (outcome?.kind === 'unauthorized') return INVALID_KEY_HEADER
    if (outcome?.kind === 'network-error' && last) {
      return `Last success ${minutesAgo(last.usage.fetchedAt, now())}m ago`
    }
    return undefined
  }

  async function describeCandidates(): Promise<string> {
    const candidates = await deps.listSites()

    // Probe concurrently: serially, unreachable candidates would drag /sub2-usage out to N x timeout (the spec requires concurrency).
    const probed = await Promise.all(
      candidates.map(async (candidate) => {
        const key = candidateKey(candidate)
        // Only negatives are in here, so a hit means "this one is already known to be a dead end".
        const known = candidateVerdicts.get(key)
        if (known) return { candidate, result: known }

        const result = await fetchUsage(candidate, {
          fetchImpl: deps.fetchImpl,
          timeoutMs: deps.timeoutMs,
        })
        if (result.kind !== 'ok') candidateVerdicts.set(key, result)
        return { candidate, result }
      }),
    )

    const lines: string[] = ['The current model is not a sub2api site.']
    let hits = 0

    for (const { candidate, result } of probed) {
      if (result.kind === 'ok') {
        // Same invariant as in run(): an `ok` body is already known to be normalizable.
        const usage = normalize(result.body)
        hits += 1
        // `formatPrimary` keeps this line agreeing with the detail view on precision and
        // on terms, so one balance cannot read as two different numbers.
        lines.push(`${candidate.provider} ${candidate.usageUrl} → ${formatPrimary(usage)}`)
        continue
      }

      const label =
        result.kind === 'unauthorized' ? 'invalid key' : result.kind === 'not-sub2api' ? 'no match' : 'network error'
      lines.push(`${candidate.provider} ${candidate.usageUrl} → ${label}`)
    }

    if (hits === 0) lines.push('No usable sub2api site found in Pi config.')
    return lines.join('\n')
  }

  async function describe(): Promise<string> {
    try {
      if (!last) {
        // An unauthorized key needs no cached balance to be worth saying: it is a positive fact
        // from a completed HTTP exchange (the same rule B1 applies to the footer), whereas a
        // network error is only the absence of information. Without this, a 401 in a fresh
        // session falls through to the candidate list, which blames the site and points the
        // user at the wrong action.
        if (outcome?.kind === 'unauthorized') return INVALID_KEY_HEADER
        // On network failure with no cached value the spec requires reporting the raw error rather than guessing at candidate sites.
        if (outcome?.kind === 'network-error') {
          return `sub2api usage query failed: ${outcome.message}`
        }
        return await describeCandidates()
      }

      const lines: string[] = []
      const header = describeHeader()
      if (header !== undefined) lines.push(header)
      lines.push(formatDetail(last.usage, last.site))
      return lines.join('\n')
    } catch (err) {
      return `sub2api usage query failed: ${errorText(err)}`
    }
  }

  function refresh(options: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
    // An in-flight request is reused even when the call is forced. That is safe: it was
    // dispatched at most one turn ago, and no spend can happen between a `turn_end` and the
    // `agent_settled` that follows it, so its numbers are never stale. Keeping exactly one
    // request in flight is what stops a burst of tool calls becoming a burst of requests.
    if (inFlight) return inFlight

    // Only the events whose number the user is actually waiting for pass force; everything
    // else is spaced out so a turn-by-turn cadence stays cheap.
    if (options.force !== true && now() - lastDispatchAt < minIntervalMs) return Promise.resolve()

    lastDispatchAt = now()
    const gen = generation
    const started = (async () => {
      try {
        await run(gen, options.timeoutMs)
      } catch (err) {
        if (gen === generation) applyFailure(errorText(err))
      }
    })()

    const tracked = started.finally(() => {
      // Identity check: only clear when this run is still the in-flight one, otherwise it would wipe a later run's dedup state.
      if (inFlight === tracked) inFlight = undefined
    })
    inFlight = tracked
    return tracked
  }

  function reset(): void {
    generation += 1
    last = undefined
    outcome = undefined
    inFlight = undefined
    // A newly selected site has never been queried, so it must not inherit the old site's throttle window.
    lastDispatchAt = Number.NEGATIVE_INFINITY
  }

  function resetCandidates(): void {
    candidateVerdicts.clear()
  }

  return { refresh, describe, reset, resetCandidates }
}

export default function createExtension(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | undefined
  let lastProvider: string | undefined

  const sourceOf = (ctx: ExtensionContext): CredentialSource => ({
    model: ctx.model ? { provider: ctx.model.provider, baseUrl: ctx.model.baseUrl } : undefined,
    modelRegistry: ctx.modelRegistry,
  })

  // The theme must be read live: ctx.ui.theme changes when the user switches themes, so it
  // cannot be frozen at factory time. Colouring stays TUI-only on purpose: Pi reports no
  // theme support in RPC mode (`getAllThemes()` returns an empty list), so status text there
  // is sent as plain characters rather than as escape sequences.
  const palette: Palette = {
    fg: (color, text) => (currentCtx?.mode === 'tui' ? currentCtx.ui.theme.fg(color, text) : text),
  }

  const refresher = createRefresher({
    resolveSite: async () => (currentCtx ? resolveCurrentSite(sourceOf(currentCtx)) : undefined),
    listSites: async () => (currentCtx ? listCandidateSites(sourceOf(currentCtx)) : []),
    palette,
    setStatus: (text, link) => {
      if (currentCtx) setFooter(currentCtx, text, link)
    },
  })

  // Fire-and-forget: refresh() guarantees it never rejects, so this catch is only a second line of defence.
  const kick = (ctx: ExtensionContext, force = false): void => {
    currentCtx = ctx
    void refresher.refresh({ force }).catch(() => {})
  }

  pi.on('session_start', (_event, ctx) => {
    currentCtx = ctx
    refresher.reset()
    refresher.resetCandidates()
    kick(ctx)
  })

  // `agent_settled` fires once, at the very end of a run, while `turn_end` fires once per LLM
  // turn inside it. One prompt can last many minutes and dozens of tool calls, so refreshing on
  // `agent_settled` alone freezes the footer for the whole of a long run — exactly when the spend
  // is climbing. `turn_end` already follows the tool results of its turn, so it covers "after a
  // tool call" as well, and `input` catches the moment just before the user spends again.
  pi.on('turn_end', (_event, ctx) => {
    kick(ctx)
  })

  pi.on('input', (_event, ctx) => {
    kick(ctx)
  })

  pi.on('agent_settled', (_event, ctx) => {
    // Forced, so the authoritative end-of-run number cannot be swallowed by the throttle window
    // that the last turn_end opened.
    kick(ctx, true)
  })

  pi.on('model_select', (event, ctx) => {
    currentCtx = ctx
    const provider = event.model.provider
    if (provider === lastProvider) return
    lastProvider = provider
    // reset() drops the cached value and the in-flight request, so the refresh that
    // follows always starts a fresh one. That is why refresh() needs no force option.
    refresher.reset()
    kick(ctx)
  })

  pi.on('session_shutdown', (_event, ctx) => {
    try {
      refresher.reset()
      refresher.resetCandidates()
      setFooter(ctx, undefined)
    } catch {
      /* A cleanup failure on the exit path must not affect Pi shutting down */
    }
  })

  pi.registerCommand('sub2-usage', {
    description: 'Show balance and usage detail for the current sub2api site',
    handler: async (_args, ctx) => {
      try {
        currentCtx = ctx
        await refresher.refresh()
        notify(ctx, await refresher.describe())
      } catch {
        /* A command handler must never throw into Pi */
      }
    },
  })
}
