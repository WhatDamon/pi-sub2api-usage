import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { fetchUsage } from './client.ts'
import { listCandidateSites, resolveCurrentSite, type CredentialSource, type SiteCredential } from './config.ts'
import { formatAmount, formatDetail, formatFooter, type Palette } from './format.ts'
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
  /** Lets tests inject a fixed clock for reset countdowns and relative times; defaults to Date.now. */
  now?: () => number
}

export interface Refresher {
  refresh(options?: { force?: boolean; timeoutMs?: number }): Promise<void>
  describe(): Promise<string>
  reset(): void
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Refresh orchestration. **The promise returned by `refresh()` never rejects** — it is
 * called fire-and-forget, and an unhandled rejection would terminate the whole session
 * via unhandledRejection.
 */
export function createRefresher(deps: RefresherDeps): Refresher {
  let last: { site: SiteCredential; usage: NormalizedUsage } | undefined
  let outcome: RefreshOutcome | undefined
  let inFlight: Promise<void> | undefined

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
      case 'ok':
        try {
          const usage = normalize(result.body)
          last = { site, usage }
          outcome = { kind: 'ok' }
          status(formatFooter({ kind: 'ok', usage, stale: false }, deps.palette, now()), site.baseUrl)
        } catch {
          // A failed normalisation counts as "this is not sub2api": clear silently rather than bother the user.
          last = undefined
          outcome = { kind: 'not-sub2api' }
          status('')
        }
        return

      case 'not-sub2api':
        // The site is no longer sub2api, so the cached value is no longer trustworthy and must be dropped.
        last = undefined
        outcome = { kind: 'not-sub2api' }
        status('')
        return

      case 'unauthorized':
        outcome = { kind: 'unauthorized', message: result.message }
        status(formatFooter({ kind: 'unauthorized' }, deps.palette, now()), site.baseUrl)
        return

      case 'network-error':
        applyFailure(result.message, site.baseUrl)
        return
    }
  }

  function describeHeader(): string | undefined {
    if (outcome?.kind === 'unauthorized') return 'API key is invalid or has expired.'
    if (outcome?.kind === 'network-error' && last) {
      return `Last success ${minutesAgo(last.usage.fetchedAt, now())}m ago`
    }
    return undefined
  }

  async function describeCandidates(): Promise<string> {
    const candidates = await deps.listSites()

    // Probe concurrently: serially, unreachable candidates would drag /sub2-usage out to N x timeout (the spec requires concurrency).
    const probed = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        result: await fetchUsage(candidate, {
          fetchImpl: deps.fetchImpl,
          timeoutMs: deps.timeoutMs,
        }),
      })),
    )

    const lines: string[] = ['The current model is not a sub2api site.']
    let hits = 0

    for (const { candidate, result } of probed) {
      if (result.kind === 'ok') {
        try {
          const usage = normalize(result.body)
          hits += 1
          const balance = formatAmount(usage.primary.value, usage.unit)
          lines.push(`${candidate.provider} ${candidate.usageUrl} → ${balance}`)
          continue
        } catch {
          /* a normalisation failure counts as no match */
        }
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
    if (inFlight) return inFlight

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
  }

  return { refresh, describe, reset }
}

export default function createExtension(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | undefined
  let lastProvider: string | undefined

  const sourceOf = (ctx: ExtensionContext): CredentialSource => ({
    model: ctx.model ? { provider: ctx.model.provider, baseUrl: ctx.model.baseUrl } : undefined,
    modelRegistry: ctx.modelRegistry,
  })

  // The theme must be read live: ctx.ui.theme changes when the user switches themes, so it cannot be frozen at factory time.
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
  const kick = (ctx: ExtensionContext, force: boolean): void => {
    currentCtx = ctx
    void refresher.refresh({ force }).catch(() => {})
  }

  pi.on('session_start', (_event, ctx) => {
    currentCtx = ctx
    refresher.reset()
    kick(ctx, true)
  })

  pi.on('agent_settled', (_event, ctx) => {
    kick(ctx, false)
  })

  pi.on('model_select', (event, ctx) => {
    currentCtx = ctx
    const provider = event.model.provider
    if (provider === lastProvider) return
    lastProvider = provider
    refresher.reset()
    kick(ctx, true)
  })

  pi.on('session_shutdown', (_event, ctx) => {
    try {
      refresher.reset()
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
        await refresher.refresh({ force: true })
        notify(ctx, await refresher.describe())
      } catch {
        /* A command handler must never throw into Pi */
      }
    },
  })
}
