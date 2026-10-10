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
 * How much slack the backstop deadline leaves beyond `timeoutMs`.
 *
 * The slack is essential: without it the backstop would fire before `AbortSignal`
 * does, and the timeout path would then bypass the mechanism that actually tears the
 * connection down.
 */
const TIMEOUT_GRACE_MS = 250

/**
 * Guarantees `work` settles within a bounded time.
 *
 * `AbortSignal.timeout()` can only interrupt a fetch implementation that **honours the
 * signal**. When the transport layer does not (certain DNS resolvers, proxies),
 * `await fetch()` never settles; because `refresh()` is called fire-and-forget, a
 * promise that never resolves would silently wedge the whole state machine. So the
 * signal does the real work (aborting the connection, releasing the socket) and this
 * adds a backstop whose only job is to stop waiting.
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

/** Replaces any occurrence of the apiKey in error text with its fingerprint. Logs and error messages may only ever contain the fingerprint. */
export function scrub(text: string, site: SiteCredential): string {
  if (site.apiKey === '') return text
  return text.replaceAll(site.apiKey, site.fingerprint)
}

/**
 * Decides whether a response body came from sub2api.
 *
 * The only criterion is the top-level `mode` field: no guessing from the hostname and
 * no reliance on the status code, because a non-sub2api gateway happily returns 200
 * with valid JSON. "Has a mode field" is what separates the two.
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
