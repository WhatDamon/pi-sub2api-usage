import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalize, UnrecognizedUsageError } from '../src/normalize.ts'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

const NOW = 1_760_000_000_000

describe('mode detection', () => {
  it('detects wallet with a shared balance when subscription/quota/rate_limits are all absent', () => {
    const u = normalize(fixture('wallet'), NOW)
    expect(u.mode).toBe('wallet')
    expect(u.sharedBalance).toBe(true)
    expect(u.primary.value).toBe(1.88485977)
    expect(u.primary.label).toContain('Wallet balance')
  })

  it('detects subscription and marks the balance as not shared', () => {
    const u = normalize(fixture('subscription'), NOW)
    expect(u.mode).toBe('subscription')
    expect(u.sharedBalance).toBe(false)
  })

  it('detects quota when quota.limit is greater than 0', () => {
    const u = normalize(fixture('quota'), NOW)
    expect(u.mode).toBe('quota')
    expect(u.primary.value).toBe(12.5)
  })

  it('detects rate_limit when only rate_limits is present', () => {
    expect(normalize(fixture('rate-limit'), NOW).mode).toBe('rate_limit')
  })

  it('prefers quota when quota and rate_limits coexist, but still keeps the windows', () => {
    const both = { ...(fixture('quota') as object), rate_limits: (fixture('rate-limit') as any).rate_limits }
    const u = normalize(both, NOW)
    expect(u.mode).toBe('quota')
    expect(u.rateLimits).toHaveLength(2)
  })
})

describe('subscription mode', () => {
  it('takes the smallest remaining amount across the three windows as the primary value', () => {
    const u = normalize(fixture('subscription'), NOW)
    expect(u.primary.value).toBe(4.0) // 1d 4.0 / 7d 14.0 / 1m 41.0 → 4.0
  })

  it('puts all three window percentages in the detail', () => {
    const u = normalize(fixture('subscription'), NOW)
    expect(u.primary.detail).toBe('1d 20% · 7d 30% · 1m 18%')
  })

  it('treats a -1 limit as unlimited and excludes it from the minimum', () => {
    const body = {
      mode: 'unrestricted', isValid: true, planName: '订阅', unit: 'USD', remaining: 9,
      subscription: {
        daily_usage_usd: 1, daily_limit_usd: -1,
        weekly_usage_usd: 6, weekly_limit_usd: 20,
        monthly_usage_usd: 9, monthly_limit_usd: 50,
      },
    }
    const u = normalize(body, NOW)
    expect(u.primary.value).toBe(14) // 1d is unlimited → min(7d 14, 1m 41)
    expect(u.primary.detail).toContain('unlimited')
  })
})

describe('rate limit mode', () => {
  it('takes the window with the highest used ratio as the primary value', () => {
    const u = normalize(fixture('rate-limit'), NOW)
    expect(u.primary.value).toBe(18) // 5h at 82% > 1d at 75%
    expect(u.primary.label).toContain('5h')
  })

  it('puts every window percentage in the detail', () => {
    const u = normalize(fixture('rate-limit'), NOW)
    expect(u.primary.detail).toBe('5h 82% · 1d 75%')
  })
})

describe('shared fields', () => {
  it('extracts today/total/daily/byModel and keeps both the actual and the list-price figures', () => {
    const u = normalize(fixture('wallet'), NOW)
    expect(u.today).toEqual({ requests: 137, totalTokens: 19304722, cost: 0.524918538, actualCost: 0.1312296345 })
    expect(u.total?.requests).toBe(1326)
    expect(u.daily.map((d) => d.date)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11'])
    expect(u.byModel).toHaveLength(2)
    expect(u.byModel[0]).toEqual({ model: 'm-1', requests: 1324, totalTokens: 127093315, actualCost: 0.911821218 })
  })

  it('uses the injected now for fetchedAt', () => {
    expect(normalize(fixture('wallet'), NOW).fetchedAt).toBe(NOW)
  })

  it('fills missing numbers with null rather than 0', () => {
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

  it('fills empty-string numeric fields with null too', () => {
    const u = normalize(
      { mode: 'unrestricted', isValid: true, planName: '钱包余额', unit: 'USD', remaining: '', usage: { total: { actual_cost: '' } } },
      NOW,
    )
    expect(u.primary.value).toBeNull()
    expect(u.total?.actualCost).toBeNull()
  })

  it('defaults planName and unit instead of throwing when they are missing', () => {
    const u = normalize({ mode: 'unrestricted', isValid: true, remaining: 1 }, NOW)
    expect(u.planName).toBe('钱包余额')
    expect(u.unit).toBe('USD')
  })
})

describe('malformed input', () => {
  it('throws UnrecognizedUsageError for an empty object', () => {
    expect(() => normalize({}, NOW)).toThrow(UnrecognizedUsageError)
  })

  it('throws UnrecognizedUsageError when mode is not in the whitelist', () => {
    expect(() => normalize({ mode: 'wat', isValid: true }, NOW)).toThrow(UnrecognizedUsageError)
  })

  it('throws UnrecognizedUsageError for null and non-object input', () => {
    expect(() => normalize(null, NOW)).toThrow(UnrecognizedUsageError)
    expect(() => normalize('nope', NOW)).toThrow(UnrecognizedUsageError)
  })
})

describe('lanes', () => {
  it('produces no lane for wallet mode', () => {
    expect(normalize(fixture('wallet'), NOW).lanes).toEqual([])
  })

  it('produces one unlabelled used percentage for quota mode, with no window reset time', () => {
    const lanes = normalize(fixture('quota'), NOW).lanes
    expect(lanes).toHaveLength(1)
    expect(lanes[0]?.label).toBe('')
    expect(lanes[0]?.percent).toBeCloseTo(37.5, 6) // 7.5 / 20
    expect(lanes[0]?.resetAt).toBeNull() // quota{} only has expires_at, no window-reset semantics
    expect(lanes[0]?.unlimited).toBe(false)
  })

  it('labels the subscription windows 1d/7d/1m', () => {
    const lanes = normalize(fixture('subscription'), NOW).lanes
    expect(lanes.map((lane) => lane.label)).toEqual(['1d', '7d', '1m'])
    expect(lanes.map((lane) => Math.round(lane.percent ?? -1))).toEqual([20, 30, 18])
    expect(lanes.every((lane) => lane.unlimited === false && lane.resetAt === null)).toBe(true)
  })

  it('marks a subscription window unlimited with a null percent when its limit is -1', () => {
    const body = {
      mode: 'unrestricted',
      subscription: { daily_limit_usd: -1, monthly_usage_usd: 9, monthly_limit_usd: 50 },
    }
    const lane = normalize(body, NOW).lanes[0]
    expect(lane?.label).toBe('1d')
    expect(lane?.percent).toBeNull()
    expect(lane?.unlimited).toBe(true)
  })

  it('produces one lane per rate window and parses reset_at into a millisecond timestamp', () => {
    const lanes = normalize(fixture('rate-limit'), NOW).lanes
    expect(lanes.map((lane) => lane.label)).toEqual(['5h', '1d'])
    expect(lanes.map((lane) => Math.round(lane.percent ?? -1))).toEqual([82, 75])
    expect(lanes[0]?.resetAt).toBe(Date.parse('2026-10-11T05:00:00Z'))
    expect(lanes[1]?.resetAt).toBe(Date.parse('2026-10-12T00:00:00Z'))
  })

  it('turns an unparseable reset_at into null rather than NaN', () => {
    const body = {
      mode: 'quota_limited',
      rate_limits: [{ window: '5h', limit: 100, used: 82, remaining: 18, reset_at: 'not a time' }],
    }
    expect(normalize(body, NOW).lanes[0]?.resetAt).toBeNull()
  })

  it('keeps the raw percent precision; rounding is the renderer’s job', () => {
    const body = { mode: 'unrestricted', subscription: { daily_usage_usd: 1, daily_limit_usd: 3 } }
    expect(normalize(body, NOW).lanes[0]?.percent).toBeCloseTo(33.3333, 3)
  })

  it('reflects only the primary mode in lanes when quota and rate_limits coexist, leaving the windows to the detail', () => {
    const both = { ...(fixture('quota') as object), rate_limits: (fixture('rate-limit') as any).rate_limits }
    const u = normalize(both, NOW)
    expect(u.mode).toBe('quota')
    expect(u.lanes).toHaveLength(1)
    expect(u.rateLimits).toHaveLength(2)
  })
})
