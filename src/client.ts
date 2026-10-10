import type { SiteCredential } from './config.ts'

export type ProbeResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'not-sub2api' }
  | { kind: 'network-error'; message: string }

export interface FetchUsageOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export const USER_AGENT = 'pi/1.0.0'
export const DEFAULT_TIMEOUT_MS = 5000

/**
 * 兜底截止线相对 `timeoutMs` 的宽限。
 *
 * 必须留宽限，否则兜底会抢在 `AbortSignal` 之前触发，
 * 那样超时路径就绕过了真正的连接中断机制。
 */
const TIMEOUT_GRACE_MS = 250

/**
 * 保证 `work` 一定会在有限时间内 settle。
 *
 * `AbortSignal.timeout()` 只能中断**遵守 signal 的** fetch 实现。传输层如果不遵守
 * （某些 DNS 解析器、代理），`await fetch()` 就永不 settle，而 `refresh()` 是
 * fire-and-forget 调用的，一个永不 resolve 的 Promise 会静默卡住所状态机。
 * 这里让 signal 做主力（负责真正中断连接、释放 socket），并额外加一道只负责
 * 「不再等下去」的兜底。
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const backstop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`usage request did not settle within ${timeoutMs + TIMEOUT_GRACE_MS}ms`)),
      timeoutMs + TIMEOUT_GRACE_MS,
    )
  })

  try {
    return await Promise.race([work, backstop])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 把错误文本里出现的 apiKey 换成它的 fingerprint。日志与错误信息只允许出现指纹。 */
export function scrub(text: string, site: SiteCredential): string {
  if (site.apiKey === '') return text
  return text.replaceAll(site.apiKey, site.fingerprint)
}

/**
 * 判定响应体是否来自 sub2api。
 *
 * 唯一判据是顶层 `mode` 字段，不猜域名、不看状态码——非 sub2api 的网关
 * 也会返回 200 + 合法 JSON，靠「有 mode 字段」才能把它们区分开。
 */
export function isSub2ApiBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const mode = (body as Record<string, unknown>).mode
  return mode === 'quota_limited' || mode === 'unrestricted'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function fetchUsage(
  site: SiteCredential,
  options: FetchUsageOptions = {},
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let res: Response
  try {
    res = await withDeadline(
      fetchImpl(site.usageUrl, {
        headers: {
          Authorization: `Bearer ${site.apiKey}`,
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs,
    )
  } catch (err) {
    return { kind: 'network-error', message: scrub(errorMessage(err), site) }
  }

  if (res.status === 401 || res.status === 403) {
    return { kind: 'unauthorized', message: `HTTP ${res.status}` }
  }
  if (res.status === 404 || res.status === 410) {
    return { kind: 'not-sub2api' }
  }
  if (!res.ok) {
    return { kind: 'network-error', message: `HTTP ${res.status}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { kind: 'not-sub2api' }
  }

  if (!isSub2ApiBody(body)) return { kind: 'not-sub2api' }
  if ((body as Record<string, unknown>).isValid === false) {
    return { kind: 'unauthorized', message: 'isValid=false' }
  }

  return { kind: 'ok', body }
}
