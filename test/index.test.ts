import { describe, expect, it, vi } from 'vitest'
import createExtension, { createRefresher } from '../src/index.ts'
import { PLAIN_PALETTE, type Palette } from '../src/format.ts'
import type { SiteCredential } from '../src/config.ts'

const NOW = 1_760_000_000_000

const site: SiteCredential = {
  provider: 'site-a',
  baseUrl: 'https://gw.example.com',
  usageUrl: 'https://gw.example.com/v1/usage',
  apiKey: 'sk-secret-abcdef123456',
  fingerprint: 'deadbeef',
}

const walletBody = {
  mode: 'unrestricted', isValid: true, planName: '钱包余额', unit: 'USD', remaining: 1.88485977, balance: 1.88485977,
  usage: { total: { requests: 10, total_tokens: 1000, cost: 1, actual_cost: 0.25 } },
}

const okFetch = (async () =>
  new Response(JSON.stringify(walletBody), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

const makeRefresher = (overrides: Partial<Parameters<typeof createRefresher>[0]> = {}) => {
  const statuses: Array<string | undefined> = []
  const links: Array<string | undefined> = []
  const refresher = createRefresher({
    resolveSite: async () => site,
    listSites: async () => [site],
    fetchImpl: okFetch,
    palette: PLAIN_PALETTE,
    setStatus: (text, link) => {
      statuses.push(text)
      links.push(link)
    },
    ...overrides,
  })
  return { refresher, statuses, links }
}

describe('createRefresher', () => {
  it('writes the balance into the footer on success', async () => {
    const { refresher, statuses } = makeRefresher()
    await refresher.refresh()
    expect(statuses.at(-1)).toBe('Sub2 $1.88')
  })

  it('attaches the site root as a clickable link on the footer text', async () => {
    const { refresher, links } = makeRefresher()
    await refresher.refresh()
    expect(links.at(-1)).toBe('https://gw.example.com')
  })

  it('takes its colours from the injected palette instead of deciding on its own', async () => {
    const tagged: Palette = { fg: (color, text) => `<${color}>${text}</${color}>` }
    const { refresher, statuses } = makeRefresher({ palette: tagged })
    await refresher.refresh()
    // 1.8848... < $2 -> warning; walletBody carries no today segment
    expect(statuses.at(-1)).toBe('<dim>Sub2</dim> <warning>$1.88</warning>')
  })

  it('shows window percentages and a reset countdown for non-wallet modes', async () => {
    const rateBody = {
      mode: 'quota_limited',
      isValid: true,
      unit: 'USD',
      rate_limits: [
        { window: '5h', limit: 100, used: 82, remaining: 18, reset_at: new Date(NOW + 42 * 60_000).toISOString() },
      ],
    }
    const rateFetch = (async () =>
      new Response(JSON.stringify(rateBody), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const { refresher, statuses } = makeRefresher({ fetchImpl: rateFetch, now: () => NOW })
    await refresher.refresh()
    expect(statuses.at(-1)).toBe('Sub2 5h 82% [⟳ 42m]')
  })

  it('resolves rather than throwing when fetch always rejects (an unhandled rejection would kill the session)', async () => {
    const alwaysReject = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: alwaysReject })
    await expect(refresher.refresh()).resolves.toBeUndefined()
  })

  it('a permanently pending fetch does not make refresh throw either', async () => {
    const never = (async () => new Promise(() => {})) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: never })
    await expect(refresher.refresh({ timeoutMs: 20 })).resolves.toBeUndefined()
  })

  it('clears the footer when a non-sub2api site is detected', async () => {
    const notSub2 = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const { refresher, statuses } = makeRefresher({ fetchImpl: notSub2 })
    await refresher.refresh()
    expect(statuses.at(-1)).toBe('')
  })

  it('clears the footer with no link when no site is detected', async () => {
    const notSub2 = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const { refresher, links } = makeRefresher({ fetchImpl: notSub2 })
    await refresher.refresh()
    expect(links.at(-1)).toBeUndefined()
  })

  it('puts the footer into its alert state when the key is invalid', async () => {
    const unauth = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const { refresher, statuses } = makeRefresher({ fetchImpl: unauth })
    await refresher.refresh()
    expect(statuses.at(-1)).toBe('Sub2 !')
  })

  it('keeps the last successful value and marks it stale when a refresh fails', async () => {
    let mode: 'ok' | 'fail' = 'ok'
    const flaky = (async () => {
      if (mode === 'fail') throw new Error('down')
      return new Response(JSON.stringify(walletBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const { refresher, statuses } = makeRefresher({ fetchImpl: flaky })
    await refresher.refresh()
    mode = 'fail'
    await refresher.refresh()
    expect(statuses.at(-1)).toBe('Sub2 ~$1.88')
  })

  it('issues only one request at a time, with concurrent calls reusing the in-flight promise', async () => {
    let calls = 0
    const slow = (async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 20))
      return new Response(JSON.stringify(walletBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: slow })
    await Promise.all([refresher.refresh(), refresher.refresh(), refresher.refresh()])
    expect(calls).toBe(1)
  })

  it('a non-forced refresh does not re-request while one is in flight', async () => {
    let calls = 0
    const slow = (async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 10))
      return new Response(JSON.stringify(walletBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: slow })
    const a = refresher.refresh()
    const b = refresher.refresh()
    await Promise.all([a, b])
    expect(calls).toBe(1)
  })

  it('describe() returns detail text, listing candidates when no site is detected', async () => {
    const { refresher } = makeRefresher()
    await refresher.refresh()
    expect(await refresher.describe()).toContain('Wallet balance')
  })

  it('describe() explains why and lists candidates when no site is detected', async () => {
    const notSub2 = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: notSub2 })
    await refresher.refresh()
    const text = await refresher.describe()
    expect(text).toContain('is not a sub2api site')
    expect(text).toContain('site-a')
  })

  it('renders a candidate balance at balance precision, matching what the detail line shows', async () => {
    // The current model is not sub2api, so describe() falls through to the candidate scan.
    // That line has to agree with the detail view on precision and on terms, otherwise one
    // command shows the same balance as two different numbers.
    const refresher = createRefresher({
      resolveSite: async () => undefined,
      listSites: async () => [site],
      fetchImpl: okFetch,
      palette: PLAIN_PALETTE,
      setStatus: () => {},
    })
    const text = await refresher.describe()
    expect(text).toContain('→ $1.88')
    expect(text).not.toContain('$1.8849')
  })
})

describe('factory', () => {
  it('registers no long-lived resources, only one command and four events', () => {
    const commands: string[] = []
    const events: string[] = []
    const pi = {
      registerCommand: (name: string) => { commands.push(name) },
      on: (event: string) => { events.push(event); return () => {} },
    }
    createExtension(pi as never)
    expect(commands).toEqual(['sub2-usage'])
    expect(events.sort()).toEqual(['agent_settled', 'model_select', 'session_shutdown', 'session_start'])
  })

  it('performs no network request inside the factory body', () => {
    const spy = vi.fn()
    const original = globalThis.fetch
    globalThis.fetch = spy as never
    try {
      createExtension({ registerCommand: () => {}, on: () => () => {} } as never)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('fix round: review findings', () => {
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  const tick = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 500 && !predicate(); i += 1) await Promise.resolve()
  }

  it('#1 reset() expires the in-flight request: a slow response from the old site must not overwrite the new site footer', async () => {
    const statuses: Array<string | undefined> = []
    let provider = 'slow-a'
    let markDispatched: (() => void) | undefined
    let releaseSlow: (() => void) | undefined
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve })

    const gated = (async () => {
      const remaining = provider === 'slow-a' ? 111 : 222
      markDispatched?.()
      if (remaining === 111) await new Promise<void>((resolve) => { releaseSlow = resolve })
      return jsonResponse({ ...walletBody, remaining })
    }) as unknown as typeof fetch

    const refresher = createRefresher({
      resolveSite: async () => ({ ...site, provider }),
      listSites: async () => [],
      fetchImpl: gated,
      palette: PLAIN_PALETTE,
      setStatus: (text) => statuses.push(text),
    })

    const stale = refresher.refresh()
    await dispatched // make sure the old site request has been dispatched
    refresher.reset()
    provider = 'fast-b'
    await refresher.refresh()
    expect(statuses.at(-1)).toBe('Sub2 $222.00')

    releaseSlow?.()
    await stale
    expect(statuses.at(-1)).toBe('Sub2 $222.00') // the stale response must not overwrite
  })

  it('#1 an old request finishing must not clear the new request inFlight (or concurrency dedup breaks)', async () => {
    let calls = 0
    const releases: Array<() => void> = []
    const gated = (async () => {
      calls += 1
      await new Promise<void>((resolve) => releases.push(resolve))
      return jsonResponse(walletBody)
    }) as unknown as typeof fetch

    const refresher = createRefresher({
      resolveSite: async () => site,
      listSites: async () => [],
      fetchImpl: gated,
      palette: PLAIN_PALETTE,
      setStatus: () => {},
    })

    const stale = refresher.refresh()
    await tick(() => releases.length >= 1)
    refresher.reset()
    const fresh = refresher.refresh()
    await tick(() => releases.length >= 2)

    releases[0]?.() // the old request finishes
    await stale

    const extra = refresher.refresh() // must reuse the fresh in-flight promise
    // with the bug, call 3 gets dispatched here; tick naturally exhausts when nothing new is sent
    await tick(() => releases.length >= 3)
    expect(calls).toBe(2)

    releases[1]?.()
    await Promise.all([fresh, extra])
    expect(calls).toBe(2)
  })

  it('#2 with an invalid key and a cached value, describe() says so rather than reporting a network blip', async () => {
    let mode: 'ok' | 'unauth' = 'ok'
    const flaky = (async () =>
      mode === 'ok' ? jsonResponse(walletBody) : new Response('{}', { status: 401 })) as unknown as typeof fetch

    const { refresher } = makeRefresher({ fetchImpl: flaky })
    await refresher.refresh()
    mode = 'unauth'
    await refresher.refresh()

    const text = await refresher.describe()
    expect(text).toContain('API key is invalid')
    expect(text).not.toContain('Last success')
  })

  it('#2 with a network failure and no cached value, describe() reports the raw error', async () => {
    const boom = (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:443') }) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: boom })
    await refresher.refresh()
    expect(await refresher.describe()).toContain('ECONNREFUSED')
  })

  it('#3 the second-tier probe is concurrent: every candidate request is dispatched at once', async () => {
    let dispatchedCount = 0
    const releases: Array<() => void> = []
    const gated = (async () => {
      dispatchedCount += 1
      await new Promise<void>((resolve) => releases.push(resolve))
      return jsonResponse({ error: 'nope' })
    }) as unknown as typeof fetch

    const candidates = ['a', 'b', 'c'].map((provider) => ({ ...site, provider }))
    const refresher = createRefresher({
      resolveSite: async () => undefined,
      listSites: async () => candidates,
      fetchImpl: gated,
      palette: PLAIN_PALETTE,
      setStatus: () => {},
    })

    const pending = refresher.describe()
    await tick(() => dispatchedCount === 3) // a serial implementation would stall at 1 here
    expect(dispatchedCount).toBe(3)

    for (const release of releases) release()
    await pending
  })
})
