import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { fetchUsage } from './client.ts'
import { listCandidateSites, resolveCurrentSite, type CredentialSource, type SiteCredential } from './config.ts'
import { formatAmount, formatDetail, formatFooter } from './format.ts'
import { normalize, type NormalizedUsage } from './normalize.ts'
import { notify, setFooter } from './ui.ts'

export interface RefresherDeps {
  resolveSite: (ctx?: ExtensionContext) => Promise<SiteCredential | undefined>
  listSites: (ctx?: ExtensionContext) => Promise<SiteCredential[]>
  fetchImpl?: typeof fetch
  setStatus: (text: string | undefined) => void
  timeoutMs?: number
}

export interface Refresher {
  refresh(options?: { force?: boolean; timeoutMs?: number }): Promise<void>
  describe(): Promise<string>
  reset(): void
}

/** 上一次刷新的结局。`describe()` 的文案由它决定，而不是由「有没有旧值」决定。 */
type RefreshOutcome =
  | { kind: 'ok' }
  | { kind: 'not-sub2api' }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'network-error'; message: string }

function minutesAgo(fetchedAt: number): number {
  return Math.max(0, Math.round((Date.now() - fetchedAt) / 60_000))
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 刷新编排。**`refresh()` 的返回 Promise 永不 reject** —— 它是 fire-and-forget
 * 调用的，未捕获的 rejection 会因 unhandledRejection 终止整个会话。
 */
export function createRefresher(deps: RefresherDeps): Refresher {
  let last: { site: SiteCredential; usage: NormalizedUsage } | undefined
  let outcome: RefreshOutcome | undefined
  let inFlight: Promise<void> | undefined

  /**
   * 代数计数器。`reset()` 自增它，从而让**在途**的刷新过期。
   *
   * 没有它会出现两种真实故障：切换模型后旧站点的慢响应返回，把错误的余额写进
   * 新模型的 footer；以及旧请求结束时无条件清掉 `inFlight`，把新请求的并发去重
   * 一起清掉（规格 §9 要求同一时刻只允许一次在途请求）。
   */
  let generation = 0

  const status = (text: string | undefined): void => {
    try {
      deps.setStatus(text)
    } catch {
      /* UI 失败不应影响刷新流程 */
    }
  }

  const applyFailure = (message: string): void => {
    outcome = { kind: 'network-error', message }
    status(formatFooter({ kind: 'error', usage: last?.usage ?? null }))
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
    // 关键关卡：过期请求不得再改动任何状态，包括 footer。
    if (gen !== generation) return

    switch (result.kind) {
      case 'ok':
        try {
          const usage = normalize(result.body)
          last = { site, usage }
          outcome = { kind: 'ok' }
          status(formatFooter({ kind: 'ok', usage, stale: false }))
        } catch {
          // 判定失败即视为「这不是 sub2api」，静默清空而不是打扰用户。
          last = undefined
          outcome = { kind: 'not-sub2api' }
          status('')
        }
        return

      case 'not-sub2api':
        // 站点已不是 sub2api，旧值不再可信，必须丢弃。
        last = undefined
        outcome = { kind: 'not-sub2api' }
        status('')
        return

      case 'unauthorized':
        outcome = { kind: 'unauthorized', message: result.message }
        status('sub2 !')
        return

      case 'network-error':
        applyFailure(result.message)
        return
    }
  }

  function describeHeader(): string | undefined {
    if (outcome?.kind === 'unauthorized') return 'API Key 无效或已过期。'
    if (outcome?.kind === 'network-error' && last) {
      return `上次成功于 ${minutesAgo(last.usage.fetchedAt)} 分钟前`
    }
    return undefined
  }

  async function describeCandidates(): Promise<string> {
    const candidates = await deps.listSites()

    // 并发探测：串行会让不可达的候选把 `/sub2-usage` 拖到 N×超时（规格 §8 要求并发）。
    const probed = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        result: await fetchUsage(candidate, {
          fetchImpl: deps.fetchImpl,
          timeoutMs: deps.timeoutMs,
        }),
      })),
    )

    const lines: string[] = ['当前模型不是 sub2api 站点。']
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
          /* normalize 失败按未命中处理 */
        }
      }

      const label =
        result.kind === 'unauthorized' ? 'Key 无效' : result.kind === 'not-sub2api' ? '未命中' : '网络失败'
      lines.push(`${candidate.provider} ${candidate.usageUrl} → ${label}`)
    }

    if (hits === 0) lines.push('未在 Pi 配置中发现可用的 sub2api 站点。')
    return lines.join('\n')
  }

  async function describe(): Promise<string> {
    try {
      if (!last) {
        // 网络失败且无旧值时，规格 §10 要求把原始错误说出来，而不是去猜候选站点。
        if (outcome?.kind === 'network-error') {
          return `sub2api 用量查询失败：${outcome.message}`
        }
        return await describeCandidates()
      }

      const lines: string[] = []
      const header = describeHeader()
      if (header !== undefined) lines.push(header)
      lines.push(formatDetail(last.usage, last.site))
      return lines.join('\n')
    } catch (err) {
      return `sub2api 用量查询失败：${errorText(err)}`
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
      // 身份比较：只有自己仍是在途请求时才清除，否则会误清后来者的去重状态。
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

  const refresher = createRefresher({
    resolveSite: async () => (currentCtx ? resolveCurrentSite(sourceOf(currentCtx)) : undefined),
    listSites: async () => (currentCtx ? listCandidateSites(sourceOf(currentCtx)) : []),
    setStatus: (text) => {
      if (currentCtx) setFooter(currentCtx, text)
    },
  })

  // fire-and-forget：refresh 自身保证不 reject，catch 只是第二道保险。
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
      /* 退出路径上的清理失败不应影响 Pi 关闭 */
    }
  })

  pi.registerCommand('sub2-usage', {
    description: '显示当前 sub2api 站点的余额与用量明细',
    handler: async (_args, ctx) => {
      try {
        currentCtx = ctx
        await refresher.refresh({ force: true })
        notify(ctx, await refresher.describe())
      } catch {
        /* 命令处理器绝不向 Pi 抛出 */
      }
    },
  })
}
