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
    let clock = NOW
    const { refresher, statuses } = makeRefresher({ fetchImpl: flaky, now: () => clock })
    await refresher.refresh()
    mode = 'fail'
    // One minute apart, which is how two refreshes actually arrive in a session: a bare
    // refresh() is throttled, so two calls in the same millisecond are not the same scenario.
    clock += 60_000
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

describe('refresh cadence during a long run', () => {
  const counting = (counter: { calls: number }): typeof fetch =>
    (async () => {
      counter.calls += 1
      return new Response(JSON.stringify(walletBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

  const jsonOk = (): Response =>
    new Response(JSON.stringify(walletBody), { status: 200, headers: { 'content-type': 'application/json' } })

  /** `run()` resolves the site before it dispatches, so the request is never sent synchronously. */
  const dispatched = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  it('collapses the turn-by-turn refreshes that land inside the minimum interval', async () => {
    // One user prompt runs for many minutes and emits a turn_end roughly every 11s. Querying
    // on every one of them would put a request per turn on the gateway for no new information.
    const counter = { calls: 0 }
    let clock = NOW
    const { refresher } = makeRefresher({ fetchImpl: counting(counter), minIntervalMs: 30_000, now: () => clock })

    await refresher.refresh()
    clock += 1_000
    await refresher.refresh()
    clock += 1_000
    await refresher.refresh()
    expect(counter.calls).toBe(1)
  })

  it('refreshes again once the minimum interval has passed', async () => {
    const counter = { calls: 0 }
    let clock = NOW
    const { refresher } = makeRefresher({ fetchImpl: counting(counter), minIntervalMs: 30_000, now: () => clock })

    await refresher.refresh()
    clock += 31_000
    await refresher.refresh()
    expect(counter.calls).toBe(2)
  })

  it('defaults to a 30s minimum interval', async () => {
    const counter = { calls: 0 }
    let clock = NOW
    const { refresher } = makeRefresher({ fetchImpl: counting(counter), now: () => clock })

    await refresher.refresh()
    clock += 29_000
    await refresher.refresh()
    expect(counter.calls).toBe(1)
    clock += 2_000
    await refresher.refresh()
    expect(counter.calls).toBe(2)
  })

  it('a forced refresh ignores the minimum interval', async () => {
    // agent_settled fires once, at the very end of a run. That is the number the user is
    // waiting for, so it must never be swallowed by the throttle window.
    const counter = { calls: 0 }
    let clock = NOW
    const { refresher } = makeRefresher({ fetchImpl: counting(counter), minIntervalMs: 30_000, now: () => clock })

    await refresher.refresh()
    clock += 1_000
    await refresher.refresh({ force: true })
    expect(counter.calls).toBe(2)
  })

  it('a failed refresh still opens the interval, so a gateway that is down is not hammered', async () => {
    const counter = { calls: 0 }
    let clock = NOW
    const boom = (async () => {
      counter.calls += 1
      throw new Error('down')
    }) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: boom, minIntervalMs: 30_000, now: () => clock })

    await refresher.refresh()
    clock += 1_000
    await refresher.refresh()
    expect(counter.calls).toBe(1)
  })

  it('reset() clears the interval too, so a newly selected site is queried immediately', async () => {
    const counter = { calls: 0 }
    let clock = NOW
    const { refresher } = makeRefresher({ fetchImpl: counting(counter), minIntervalMs: 30_000, now: () => clock })

    await refresher.refresh()
    clock += 1_000
    refresher.reset()
    await refresher.refresh()
    expect(counter.calls).toBe(2)
  })

  it('a forced refresh arriving while one is in flight keeps exactly one request in flight', async () => {
    // Reusing the in-flight request is safe: it was dispatched at most one turn ago, and no
    // spend can happen between a turn_end and the agent_settled that follows it. Keeping one
    // request in flight is what stops a burst of tool calls becoming a burst of requests.
    let calls = 0
    const releases: Array<() => void> = []
    const gated = (async () => {
      calls += 1
      await new Promise<void>((resolve) => releases.push(resolve))
      return jsonOk()
    }) as unknown as typeof fetch

    const { refresher } = makeRefresher({ fetchImpl: gated, minIntervalMs: 30_000, now: () => NOW })
    const first = refresher.refresh()
    const forced = refresher.refresh({ force: true })
    await dispatched(() => calls === 1)
    expect(calls).toBe(1)

    releases[0]?.()
    await Promise.all([first, forced])
    expect(calls).toBe(1)
  })
})

describe('factory', () => {
  it('registers no long-lived resources, only one command and six events', () => {
    const commands: string[] = []
    const events: string[] = []
    const pi = {
      registerCommand: (name: string) => { commands.push(name) },
      on: (event: string) => { events.push(event); return () => {} },
    }
    createExtension(pi as never)
    expect(commands).toEqual(['sub2-usage'])
    // turn_end and input are what keep a long run's footer moving: agent_settled fires only
    // once, at the very end, and a single prompt can run for many minutes and dozens of turns.
    expect(events.sort()).toEqual([
      'agent_settled',
      'input',
      'model_select',
      'session_shutdown',
      'session_start',
      'turn_end',
    ])
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

describe('factory refresh wiring', () => {
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  const withClock = async (body: (advance: (ms: number) => void) => Promise<void>): Promise<void> => {
    let clock = NOW
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      await body((ms) => { clock += ms })
    } finally {
      spy.mockRestore()
    }
  }

  /** Wires the real factory to a fake Pi and a fake context, so the wiring itself is under test. */
  const harness = (counter: { calls: number }) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const statuses: Array<string | undefined> = []
    const pi = {
      registerCommand: () => {},
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(event, handler)
        return () => {}
      },
    }
    const ctx = {
      // RPC mode keeps the status text free of the OSC 8 link, so these assertions stay about
      // *when* something is refreshed rather than about how it is rendered.
      mode: 'rpc',
      hasUI: true,
      model: { provider: 'site-a', baseUrl: 'https://gw.example.com' },
      modelRegistry: {
        getApiKeyForProvider: async () => 'sk-secret-abcdef123456',
        getAll: () => [{ provider: 'site-a', baseUrl: 'https://gw.example.com' }],
      },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: (_key: string, text: string | undefined) => { statuses.push(text) },
        notify: () => {},
      },
    }
    globalThis.fetch = (async () => {
      counter.calls += 1
      return new Response(JSON.stringify(walletBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    createExtension(pi as never)
    return { handlers, statuses, ctx }
  }

  const fire = async (
    handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
    name: string,
    ctx: unknown,
  ): Promise<void> => {
    await handlers.get(name)?.({ type: name }, ctx)
  }

  it('refreshes on turn_end, which is what stops a long run freezing the footer', async () => {
    const counter = { calls: 0 }
    const original = globalThis.fetch
    try {
      await withClock(async (advance) => {
        const { handlers, statuses, ctx } = harness(counter)
        await fire(handlers, 'session_start', ctx)
        await waitFor(() => counter.calls === 1)
        expect(statuses.at(-1)).toBe('Sub2 $1.88')

        // Inside the throttle window a turn_end must not add a request.
        advance(1_000)
        await fire(handlers, 'turn_end', ctx)
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(counter.calls).toBe(1)

        // Past it, the next turn refreshes again: this is what keeps the number moving.
        advance(31_000)
        await fire(handlers, 'turn_end', ctx)
        await waitFor(() => counter.calls === 2)
        // Assert the count, not just the text: the text is already 'Sub2 $1.88' from
        // session_start, so without this the test would pass with turn_end unwired.
        expect(counter.calls).toBe(2)
        expect(statuses.at(-1)).toBe('Sub2 $1.88')
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it('refreshes on input, so the balance is current when the user is about to spend', async () => {
    const counter = { calls: 0 }
    const original = globalThis.fetch
    try {
      await withClock(async (advance) => {
        const { handlers, ctx } = harness(counter)
        await fire(handlers, 'session_start', ctx)
        await waitFor(() => counter.calls === 1)

        advance(31_000)
        await fire(handlers, 'input', ctx)
        await waitFor(() => counter.calls === 2)
        expect(counter.calls).toBe(2)
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it('agent_settled refreshes even inside the minimum interval', async () => {
    const counter = { calls: 0 }
    const original = globalThis.fetch
    try {
      await withClock(async (advance) => {
        const { handlers, ctx } = harness(counter)
        await fire(handlers, 'session_start', ctx)
        await waitFor(() => counter.calls === 1)

        // The end of a run is the number the user is actually waiting for, so the throttle
        // must not swallow it.
        advance(1_000)
        await fire(handlers, 'agent_settled', ctx)
        await waitFor(() => counter.calls === 2)
        expect(counter.calls).toBe(2)
      })
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

    let clock = NOW
    const { refresher } = makeRefresher({ fetchImpl: flaky, now: () => clock })
    await refresher.refresh()
    mode = 'unauth'
    clock += 60_000
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
