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
    res = await fetchImpl(site.usageUrl, {
      headers: {
        Authorization: `Bearer ${site.apiKey}`,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
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
