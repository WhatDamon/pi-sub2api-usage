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
  it('replaces the apiKey with its fingerprint and keeps the rest of the text', () => {
    expect(scrub(`fetch failed for ${site.apiKey} at gw`, site)).toBe(
      `fetch failed for ${site.fingerprint} at gw`,
    )
  })
})

describe('fetchUsage classification', () => {
  it('treats 200 with a mode field as sub2api', async () => {
    const r = await fetchUsage(site, { fetchImpl: respond(200, sub2apiBody) })
    expect(r.kind).toBe('ok')
  })

  it('treats 200 with an empty object body as not-sub2api', async () => {
    expect((await fetchUsage(site, { fetchImpl: respond(200, {}) })).kind).toBe('not-sub2api')
  })

  it('treats 200 with an error object body as not-sub2api', async () => {
    const r = await fetchUsage(site, { fetchImpl: respond(200, { error: 'invalid api key' }) })
    expect(r.kind).toBe('not-sub2api')
  })

  it('treats 200 with an HTML body as not-sub2api', async () => {
    const r = await fetchUsage(site, { fetchImpl: respond(200, '<html>nope</html>', 'text/html') })
    expect(r.kind).toBe('not-sub2api')
  })

  it('treats 401 as unauthorized', async () => {
    expect((await fetchUsage(site, { fetchImpl: respond(401, { error: 'unauthorized' }) })).kind).toBe('unauthorized')
  })

  it('treats 403 as unauthorized', async () => {
    expect((await fetchUsage(site, { fetchImpl: respond(403, {}) })).kind).toBe('unauthorized')
  })

  it('treats 200 with isValid false as unauthorized', async () => {
    const r = await fetchUsage(site, { fetchImpl: respond(200, { ...sub2apiBody, isValid: false }) })
    expect(r.kind).toBe('unauthorized')
  })

  it('treats 404 as not-sub2api', async () => {
    expect((await fetchUsage(site, { fetchImpl: respond(404, {}) })).kind).toBe('not-sub2api')
  })

  it('treats 500 as network-error rather than not-sub2api', async () => {
    expect((await fetchUsage(site, { fetchImpl: respond(500, {}) })).kind).toBe('network-error')
  })

  it('treats a throwing fetch as network-error with the message scrubbed', async () => {
    const boom = (async () => { throw new Error(`request to https://gw/v1/usage failed, key ${site.apiKey}`) }) as unknown as typeof fetch
    const r = await fetchUsage(site, { fetchImpl: boom })
    expect(r.kind).toBe('network-error')
    if (r.kind !== 'network-error') throw new Error('unreachable')
    expect(r.message).not.toContain(site.apiKey)
    expect(r.message).toContain(site.fingerprint)
  })

  it('treats a timeout as network-error (proving AbortSignal is wired up)', async () => {
    const never = (async (_url: URL | string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
      })) as unknown as typeof fetch
    const r = await fetchUsage(site, { fetchImpl: never, timeoutMs: 20 })
    expect(r.kind).toBe('network-error')
  })

  it('sends Bearer and the pi User-Agent, and keeps the key out of the URL', async () => {
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
