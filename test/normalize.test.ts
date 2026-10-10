import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalize, UnrecognizedUsageError } from '../src/normalize.ts'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

const NOW = 1_760_000_000_000

describe('形态判定', () => {
  it('无 subscription/quota/rate_limits 判为 wallet 且标记余额共享', () => {
    const u = normalize(fixture('wallet'), NOW)
    expect(u.mode).toBe('wallet')
    expect(u.sharedBalance).toBe(true)
    expect(u.primary.value).toBe(1.88485977)
    expect(u.primary.label).toContain('钱包余额')
  })

  it('有 subscription 判为 subscription 且不共享', () => {
    const u = normalize(fixture('subscription'), NOW)
    expect(u.mode).toBe('subscription')
    expect(u.sharedBalance).toBe(false)
  })

  it('quota.limit 大于 0 判为 quota', () => {
    const u = normalize(fixture('quota'), NOW)
    expect(u.mode).toBe('quota')
    expect(u.primary.value).toBe(12.5)
  })

  it('只有 rate_limits 时判为 rate_limit', () => {
    expect(normalize(fixture('rate-limit'), NOW).mode).toBe('rate_limit')
  })

  it('quota 与 rate_limits 同时存在时以 quota 为主，但窗口仍然保留', () => {
    const both = { ...(fixture('quota') as object), rate_limits: (fixture('rate-limit') as any).rate_limits }
    const u = normalize(both, NOW)
    expect(u.mode).toBe('quota')
    expect(u.rateLimits).toHaveLength(2)
  })
})

describe('订阅形态', () => {
  it('primary 取三窗口剩余的最小值', () => {
    const u = normalize(fixture('subscription'), NOW)
    expect(u.primary.value).toBe(4.0) // 日 4.0 / 周 14.0 / 月 41.0 → 4.0
  })

  it('detail 含三个窗口的使用率百分比', () => {
    const u = normalize(fixture('subscription'), NOW)
    expect(u.primary.detail).toBe('日 20% · 周 30% · 月 18%')
  })

  it('limit 为 -1 的窗口视为无限，不参与最小值计算', () => {
    const body = {
      mode: 'unrestricted', isValid: true, planName: '订阅', unit: 'USD', remaining: 9,
      subscription: {
        daily_usage_usd: 1, daily_limit_usd: -1,
        weekly_usage_usd: 6, weekly_limit_usd: 20,
        monthly_usage_usd: 9, monthly_limit_usd: 50,
      },
    }
    const u = normalize(body, NOW)
    expect(u.primary.value).toBe(14) // 日视为无限 → 周 14 与 月 41 取小
    expect(u.primary.detail).toContain('无限')
  })
})

describe('速率限制形态', () => {
  it('primary 取使用率最高的窗口', () => {
    const u = normalize(fixture('rate-limit'), NOW)
    expect(u.primary.value).toBe(18) // 5h 用 82% > 1d 用 75%
    expect(u.primary.label).toContain('5h')
  })

  it('detail 含全部窗口的使用率', () => {
    const u = normalize(fixture('rate-limit'), NOW)
    expect(u.primary.detail).toBe('5h 82% · 1d 75%')
  })
})

describe('公共字段', () => {
  it('today/total/daily/byModel 被提取并保留实付与原价两个口径', () => {
    const u = normalize(fixture('wallet'), NOW)
    expect(u.today).toEqual({ requests: 137, totalTokens: 19304722, cost: 0.524918538, actualCost: 0.1312296345 })
    expect(u.total?.requests).toBe(1326)
    expect(u.daily.map((d) => d.date)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11'])
    expect(u.byModel).toHaveLength(2)
    expect(u.byModel[0]).toEqual({ model: 'm-1', requests: 1324, totalTokens: 127093315, actualCost: 0.911821218 })
  })

  it('fetchedAt 用注入的 now', () => {
    expect(normalize(fixture('wallet'), NOW).fetchedAt).toBe(NOW)
  })

  it('缺失的数值填 null 而不是 0', () => {
    const u = normalize({ mode: 'unrestricted', isValid: true, planName: '钱包余额', unit: 'USD', remaining: 5 }, NOW)
    expect(u.today).toBeNull()
    expect(u.total).toBeNull()
    expect(u.daily).toEqual([])
    expect(u.byModel).toEqual([])

    const partial = normalize(
      { mode: 'unrestricted', isValid: true, planName: '钱包余额', unit: 'USD', remaining: 5, usage: { total: { requests: 3 } } },
      NOW,
    )
    expect(partial.total).toEqual({ requests: 3, totalTokens: null, cost: null, actualCost: null })
  })

  it('空字符串的数值字段也填 null', () => {
    const u = normalize(
      { mode: 'unrestricted', isValid: true, planName: '钱包余额', unit: 'USD', remaining: '', usage: { total: { actual_cost: '' } } },
      NOW,
    )
    expect(u.primary.value).toBeNull()
    expect(u.total?.actualCost).toBeNull()
  })

  it('planName 与 unit 缺失时给默认值，不抛错', () => {
    const u = normalize({ mode: 'unrestricted', isValid: true, remaining: 1 }, NOW)
    expect(u.planName).toBe('钱包余额')
    expect(u.unit).toBe('USD')
  })
})

describe('畸形输入', () => {
  it('空对象抛 UnrecognizedUsageError', () => {
    expect(() => normalize({}, NOW)).toThrow(UnrecognizedUsageError)
  })

  it('mode 取值不在白名单时抛 UnrecognizedUsageError', () => {
    expect(() => normalize({ mode: 'wat', isValid: true }, NOW)).toThrow(UnrecognizedUsageError)
  })

  it('null 与非对象输入抛 UnrecognizedUsageError', () => {
    expect(() => normalize(null, NOW)).toThrow(UnrecognizedUsageError)
    expect(() => normalize('nope', NOW)).toThrow(UnrecognizedUsageError)
  })
})

describe('lanes', () => {
  it('钱包形态没有窗口', () => {
    expect(normalize(fixture('wallet'), NOW).lanes).toEqual([])
  })

  it('配额形态给出一个不带标签的已用百分比，且没有窗口重置时间', () => {
    const lanes = normalize(fixture('quota'), NOW).lanes
    expect(lanes).toHaveLength(1)
    expect(lanes[0]?.label).toBe('')
    expect(lanes[0]?.percent).toBeCloseTo(37.5, 6) // 7.5 / 20
    expect(lanes[0]?.resetAt).toBeNull() // quota{} 只有 expires_at，没有窗口重置语义
    expect(lanes[0]?.unlimited).toBe(false)
  })

  it('订阅形态用 1d/7d/1m 标签', () => {
    const lanes = normalize(fixture('subscription'), NOW).lanes
    expect(lanes.map((lane) => lane.label)).toEqual(['1d', '7d', '1m'])
    expect(lanes.map((lane) => Math.round(lane.percent ?? -1))).toEqual([20, 30, 18])
    expect(lanes.every((lane) => lane.unlimited === false && lane.resetAt === null)).toBe(true)
  })

  it('订阅窗口 limit 为 -1 时标记为无限且 percent 为 null', () => {
    const body = {
      mode: 'unrestricted',
      subscription: { daily_limit_usd: -1, monthly_usage_usd: 9, monthly_limit_usd: 50 },
    }
    const lane = normalize(body, NOW).lanes[0]
    expect(lane?.label).toBe('1d')
    expect(lane?.percent).toBeNull()
    expect(lane?.unlimited).toBe(true)
  })

  it('速率限制形态每个窗口一条，reset_at 解析为毫秒时间戳', () => {
    const lanes = normalize(fixture('rate-limit'), NOW).lanes
    expect(lanes.map((lane) => lane.label)).toEqual(['5h', '1d'])
    expect(lanes.map((lane) => Math.round(lane.percent ?? -1))).toEqual([82, 75])
    expect(lanes[0]?.resetAt).toBe(Date.parse('2026-10-11T05:00:00Z'))
    expect(lanes[1]?.resetAt).toBe(Date.parse('2026-10-12T00:00:00Z'))
  })

  it('无法解析的 reset_at 变成 null 而不是 NaN', () => {
    const body = {
      mode: 'quota_limited',
      rate_limits: [{ window: '5h', limit: 100, used: 82, remaining: 18, reset_at: '不是时间' }],
    }
    expect(normalize(body, NOW).lanes[0]?.resetAt).toBeNull()
  })

  it('percent 保留原始精度，取整是渲染层的事', () => {
    const body = { mode: 'unrestricted', subscription: { daily_usage_usd: 1, daily_limit_usd: 3 } }
    expect(normalize(body, NOW).lanes[0]?.percent).toBeCloseTo(33.3333, 3)
  })

  it('quota 与 rate_limits 并存时 lanes 只反映主形态，窗口仍留给明细', () => {
    const both = { ...(fixture('quota') as object), rate_limits: (fixture('rate-limit') as any).rate_limits }
    const u = normalize(both, NOW)
    expect(u.mode).toBe('quota')
    expect(u.lanes).toHaveLength(1)
    expect(u.rateLimits).toHaveLength(2)
  })
})
