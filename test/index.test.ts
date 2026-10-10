import { describe, expect, it, vi } from 'vitest'
import createExtension, { createRefresher } from '../src/index.ts'
import type { SiteCredential } from '../src/config.ts'

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
  const refresher = createRefresher({
    resolveSite: async () => site,
    listSites: async () => [site],
    fetchImpl: okFetch,
    setStatus: (text) => statuses.push(text),
    ...overrides,
  })
  return { refresher, statuses }
}

describe('createRefresher', () => {
  it('成功后把余额写进 footer', async () => {
    const { refresher, statuses } = makeRefresher()
    await refresher.refresh({ force: true })
    expect(statuses.at(-1)).toBe('sub2 $1.8849')
  })

  it('fetch 永远 reject 时 resolve 而不抛出（未捕获 rejection 会杀死会话）', async () => {
    const alwaysReject = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: alwaysReject })
    await expect(refresher.refresh({ force: true })).resolves.toBeUndefined()
  })

  it('永远 pending 的 fetch 也不会让 refresh 抛出', async () => {
    const never = (async () => new Promise(() => {})) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: never })
    await expect(refresher.refresh({ force: true, timeoutMs: 20 })).resolves.toBeUndefined()
  })

  it('检测到非 sub2api 时清空 footer', async () => {
    const notSub2 = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const { refresher, statuses } = makeRefresher({ fetchImpl: notSub2 })
    await refresher.refresh({ force: true })
    expect(statuses.at(-1)).toBe('')
  })

  it('Key 无效时把 footer 置为告警态', async () => {
    const unauth = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const { refresher, statuses } = makeRefresher({ fetchImpl: unauth })
    await refresher.refresh({ force: true })
    expect(statuses.at(-1)).toBe('sub2 !')
  })

  it('刷新失败时保留上一次的成功值并加上陈旧标记', async () => {
    let mode: 'ok' | 'fail' = 'ok'
    const flaky = (async () => {
      if (mode === 'fail') throw new Error('down')
      return new Response(JSON.stringify(walletBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const { refresher, statuses } = makeRefresher({ fetchImpl: flaky })
    await refresher.refresh({ force: true })
    mode = 'fail'
    await refresher.refresh({ force: true })
    expect(statuses.at(-1)).toBe('sub2 ~$1.8849')
  })

  it('同一时刻只发一次请求，并发调用复用在途 Promise', async () => {
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

  it('非强制刷新在有在途请求时不会重复发请求', async () => {
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

  it('describe() 返回详情文本，未检测到站点时给出候选列表', async () => {
    const { refresher } = makeRefresher()
    await refresher.refresh({ force: true })
    expect(await refresher.describe()).toContain('钱包余额')
  })

  it('未检测到站点时 describe() 说明原因并列出候选', async () => {
    const notSub2 = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: notSub2 })
    await refresher.refresh({ force: true })
    const text = await refresher.describe()
    expect(text).toContain('不是 sub2api')
    expect(text).toContain('site-a')
  })
})

describe('工厂函数', () => {
  it('不注册任何长驻资源，只注册一个命令与四个事件', () => {
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

  it('工厂函数体内不发网络请求', () => {
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

describe('修复轮：审查发现', () => {
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  const tick = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 500 && !predicate(); i += 1) await Promise.resolve()
  }

  it('#1 reset() 使在途请求失效：旧站点的慢响应不得覆盖新站点的 footer', async () => {
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
      setStatus: (text) => statuses.push(text),
    })

    const stale = refresher.refresh({ force: true })
    await dispatched // 确保旧站点的请求已经发出
    refresher.reset()
    provider = 'fast-b'
    await refresher.refresh({ force: true })
    expect(statuses.at(-1)).toBe('sub2 $222.0000')

    releaseSlow?.()
    await stale
    expect(statuses.at(-1)).toBe('sub2 $222.0000') // 旧响应不得覆盖
  })

  it('#1 旧请求结束时不得清掉新请求的 inFlight（否则并发去重失效）', async () => {
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
      setStatus: () => {},
    })

    const stale = refresher.refresh()
    await tick(() => releases.length >= 1)
    refresher.reset()
    const fresh = refresher.refresh()
    await tick(() => releases.length >= 2)

    releases[0]?.() // 旧请求结束
    await stale

    const extra = refresher.refresh() // 必须复用 fresh 的在途 Promise
    // 若有 bug，这里会把 call 3 发出去；tick 会在无新请求时自然耗尽
    await tick(() => releases.length >= 3)
    expect(calls).toBe(2)

    releases[1]?.()
    await Promise.all([fresh, extra])
    expect(calls).toBe(2)
  })

  it('#2 Key 无效且有旧值时 describe() 明说 Key 无效，而不是报成网络抖动', async () => {
    let mode: 'ok' | 'unauth' = 'ok'
    const flaky = (async () =>
      mode === 'ok' ? jsonResponse(walletBody) : new Response('{}', { status: 401 })) as unknown as typeof fetch

    const { refresher } = makeRefresher({ fetchImpl: flaky })
    await refresher.refresh({ force: true })
    mode = 'unauth'
    await refresher.refresh({ force: true })

    const text = await refresher.describe()
    expect(text).toContain('API Key 无效')
    expect(text).not.toContain('上次成功于')
  })

  it('#2 网络失败且无旧值时 describe() 输出原始错误信息', async () => {
    const boom = (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:443') }) as unknown as typeof fetch
    const { refresher } = makeRefresher({ fetchImpl: boom })
    await refresher.refresh({ force: true })
    expect(await refresher.describe()).toContain('ECONNREFUSED')
  })

  it('#3 第二层探测是并发的：所有候选的请求同时发出', async () => {
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
      setStatus: () => {},
    })

    const pending = refresher.describe()
    await tick(() => dispatchedCount === 3) // 串行实现下这里永远停在 1
    expect(dispatchedCount).toBe(3)

    for (const release of releases) release()
    await pending
  })
})
