import { describe, expect, it } from 'vitest'
import { fetchUsage, scrub } from '../src/client.ts'
import { keyFingerprint, type SiteCredential } from '../src/config.ts'

const site: SiteCredential = {
  provider: 'site-a',
  baseUrl: 'https://gw.example.com',
  usageUrl: 'https://gw.example.com/v1/usage',
  apiKey: 'sk-secret-abcdef123456',
  fingerprint: keyFingerprint('sk-secret-abcdef123456'),
}

const respond = (status: number, body: unknown, contentType = 'application/json'): typeof fetch =>
  (async () => new Response(contentType === 'application/json' ? JSON.stringify(body) : String(body), {
    status,
    headers: { 'content-type': contentType },
  })) as unknown as typeof fetch

const sub2apiBody = { mode: 'unrestricted', isValid: true, unit: 'USD', planName: '钱包余额', remaining: 1.5 }

describe('scrub', () => {
  it('把 apiKey 替换为 fingerprint，保留其余文本', () => {
    expect(scrub(`fetch failed for ${site.apiKey} at gw`, site)).toBe(
      `fetch failed for ${site.fingerprint} at gw`,
    )
  })
})

describe('fetchUsage 分类', () => {
  it('200 且响应含 mode 时判为 sub2api', async () => {
    const r = await fetchUsage(site, { fetchImpl: respond(200, sub2apiBody) })
    expect(r.kind).toBe('ok')
  })

  it('200 但响应是空对象时判为非 sub2api', async () => {
    expect((await fetchUsage(site, { fetchImpl: respond(200, {}) })).kind).toBe('not-sub2api')
  })

  it('200 但响应是错误对象时判为非 sub2api', async () => {
    const r = await fetchUsage(site, { fetchImpl: respond(200, { error: 'invalid api key' }) })
    expect(r.kind).toBe('not-sub2api')
  })

  it('200 但响应是 HTML 时判为非 sub2api', async () => {
    const r = await fetchUsage(site, { fetchImpl: respond(200, '<html>nope</html>', 'text/html') })
    expect(r.kind).toBe('not-sub2api')
  })

  it('401 判为 unauthorized', async () => {
    expect((await fetchUsage(site, { fetchImpl: respond(401, { error: 'unauthorized' }) })).kind).toBe('unauthorized')
  })

  it('403 判为 unauthorized', async () => {
    expect((await fetchUsage(site, { fetchImpl: respond(403, {}) })).kind).toBe('unauthorized')
  })

  it('200 但 isValid 为 false 时判为 unauthorized', async () => {
    const r = await fetchUsage(site, { fetchImpl: respond(200, { ...sub2apiBody, isValid: false }) })
    expect(r.kind).toBe('unauthorized')
  })

  it('404 判为非 sub2api', async () => {
    expect((await fetchUsage(site, { fetchImpl: respond(404, {}) })).kind).toBe('not-sub2api')
  })

  it('500 判为 network-error 而不是 not-sub2api', async () => {
    expect((await fetchUsage(site, { fetchImpl: respond(500, {}) })).kind).toBe('network-error')
  })

  it('fetch 抛错时判为 network-error 且信息已脱敏', async () => {
    const boom = (async () => { throw new Error(`request to https://gw/v1/usage failed, key ${site.apiKey}`) }) as unknown as typeof fetch
    const r = await fetchUsage(site, { fetchImpl: boom })
    expect(r.kind).toBe('network-error')
    if (r.kind !== 'network-error') throw new Error('unreachable')
    expect(r.message).not.toContain(site.apiKey)
    expect(r.message).toContain(site.fingerprint)
  })

  it('超时判为 network-error（说明 AbortSignal 已接上）', async () => {
    const never = (async (_url: URL | string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
      })) as unknown as typeof fetch
    const r = await fetchUsage(site, { fetchImpl: never, timeoutMs: 20 })
    expect(r.kind).toBe('network-error')
  })

  it('请求头带上 Bearer 与 pi User-Agent，且不把 Key 放进 URL', async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined
    const spy = (async (url: URL | string, init?: RequestInit) => {
      seen = { url: String(url), init }
      return new Response(JSON.stringify(sub2apiBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    await fetchUsage(site, { fetchImpl: spy })
    expect(seen?.url).toBe('https://gw.example.com/v1/usage')
    expect(seen?.url).not.toContain(site.apiKey)
    const headers = new Headers(seen?.init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${site.apiKey}`)
    expect(headers.get('user-agent')).toBe('pi/1.0.0')
  })
})
