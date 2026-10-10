import { describe, expect, it } from 'vitest'
import {
  FOOTER_MAX_WIDTH,
  formatAmount,
  formatDetail,
  formatFooter,
  formatTokens,
  truncateToWidth,
  visibleWidth,
  type FooterState,
} from '../src/format.ts'
import type { NormalizedUsage } from '../src/normalize.ts'
import type { SiteCredential } from '../src/config.ts'

const usage: NormalizedUsage = {
  mode: 'wallet',
  planName: '钱包余额',
  unit: 'USD',
  sharedBalance: true,
  primary: { label: '钱包余额（多 Key 共享）', value: 1.88485977, detail: undefined },
  today: { requests: 137, totalTokens: 19304722, cost: 0.524918538, actualCost: 0.1312296345 },
  total: { requests: 1326, totalTokens: 127093315, cost: 3.660560046, actualCost: 0.9151400115 },
  daily: [
    { date: '2026-10-09', requests: 690, actualCost: 0.0199 },
    { date: '2026-10-10', requests: 499, actualCost: 0.3104 },
    { date: '2026-10-11', requests: 137, actualCost: 0.1312 },
  ],
  byModel: [
    { model: 'm-1', requests: 1324, totalTokens: 127093315, actualCost: 0.911821218 },
    { model: 'm-2', requests: 2, totalTokens: 1000, actualCost: 0.003318793 },
    { model: 'm-3', requests: 1, totalTokens: 10, actualCost: 0.0001 },
    { model: 'm-4', requests: 1, totalTokens: 10, actualCost: 0.00005 },
  ],
  rateLimits: [],
  isValid: true,
  fetchedAt: 1_760_000_000_000,
}

const site: SiteCredential = {
  provider: 'site-a',
  baseUrl: 'https://gw.example.com',
  usageUrl: 'https://gw.example.com/v1/usage',
  apiKey: 'sk-secret-abcdef123456',
  fingerprint: 'deadbeef',
}

describe('visibleWidth', () => {
  it('ASCII 按 1 列，中文按 2 列，组合字符按 0 列', () => {
    expect(visibleWidth('sub2 $1.88')).toBe(10)
    expect(visibleWidth('今日')).toBe(4)
    expect(visibleWidth('今 $1.88')).toBe(8)
    expect(visibleWidth('e\u0301')).toBe(1)
    expect(visibleWidth('（原价）')).toBe(8)
  })
})

describe('truncateToWidth', () => {
  it('不超限时原样返回', () => {
    expect(truncateToWidth('abc', 5)).toBe('abc')
  })

  it('超限时按可见宽度截断', () => {
    expect(truncateToWidth('abcde', 3)).toBe('abc')
  })

  it('不会把中文截成半个', () => {
    expect(visibleWidth(truncateToWidth('今日余额', 5))).toBeLessThanOrEqual(5)
    expect(truncateToWidth('今日余额', 5)).toBe('今日')
  })
})

describe('formatTokens', () => {
  it.each([
    [999, '999'],
    [1000, '1.0K'],
    [999999, '1000.0K'],
    [1_000_000, '1.0M'],
    [127_093_315, '127.1M'],
    [1_000_000_000, '1.0B'],
    [0, '0'],
  ])('%s → %s', (input, expected) => {
    expect(formatTokens(input)).toBe(expected)
  })

  it('null 显示为破折号', () => {
    expect(formatTokens(null)).toBe('—')
  })
})

describe('formatAmount', () => {
  it('USD 用美元符号，4 位小数', () => {
    expect(formatAmount(1.88485977, 'USD')).toBe('$1.8849')
    expect(formatAmount(0, 'USD')).toBe('$0.0000')
  })

  it('CNY 用人民币符号', () => {
    expect(formatAmount(1.5, 'CNY')).toBe('¥1.5000')
  })

  it('未知单位时前置单位名', () => {
    expect(formatAmount(1.5, 'EUR')).toBe('EUR 1.5000')
  })

  it('null 显示为破折号', () => {
    expect(formatAmount(null, 'USD')).toBe('—')
  })
})

describe('formatFooter', () => {
  const cases: Array<[string, FooterState, string]> = [
    ['正常', { kind: 'ok', usage, stale: false }, 'sub2 $1.8849 · 今 $0.1312'],
    ['陈旧', { kind: 'ok', usage, stale: true }, 'sub2 ~$1.8849 · 今 $0.1312'],
    ['Key 无效', { kind: 'unauthorized' }, 'sub2 !'],
    ['失败且无旧值', { kind: 'error', usage: null }, 'sub2 ?'],
    ['失败但有旧值', { kind: 'error', usage }, 'sub2 ~$1.8849 · 今 $0.1312'],
    ['未检测到', { kind: 'idle' }, ''],
  ]

  it.each(cases)('%s', (_name, state, expected) => {
    expect(formatFooter(state)).toBe(expected)
  })

  it('全部状态的宽度都不超过上限', () => {
    for (const [, state] of cases) {
      expect(visibleWidth(formatFooter(state))).toBeLessThanOrEqual(FOOTER_MAX_WIDTH)
    }
  })

  it('余额缺值时只显示消耗', () => {
    const partial = { ...usage, primary: { ...usage.primary, value: null } }
    expect(formatFooter({ kind: 'ok', usage: partial, stale: false })).toBe('sub2 今 $0.1312')
  })

  it('今天的实付为 0 时显示 0 而不是省略', () => {
    const zero = { ...usage, today: { ...usage.today!, actualCost: 0 } }
    expect(formatFooter({ kind: 'ok', usage: zero, stale: false })).toBe('sub2 $1.8849 · 今 $0.0000')
  })
})

describe('formatDetail', () => {
  it('钱包形态的完整输出', () => {
    expect(formatDetail(usage, site)).toBe(
      [
        'sub2api · site-a',
        'https://gw.example.com',
        '钱包余额（多 Key 共享） $1.8849',
        '今日 137 req · 19.3M tok · 实付 $0.1312（原价 $0.5249）',
        '累计 1326 req · 127.1M tok · 实付 $0.9151（原价 $3.6606）',
        '近3日 10-09 $0.0199 · 10-10 $0.3104 · 10-11 $0.1312',
        '按模型 m-1 $0.9118 · 127.1M tok · 1324 req · m-2 $0.0033 · 1.0K tok · 2 req · m-3 $0.0001 · 10 tok · 1 req',
      ].join('\n'),
    )
  })

  it('缺少 daily 时省略该行', () => {
    const out = formatDetail({ ...usage, daily: [], byModel: [] }, site)
    expect(out.split('\n')).toHaveLength(5)
    expect(out).not.toContain('近3日')
  })

  it('订阅形态输出 primary 的 detail', () => {
    const sub: NormalizedUsage = {
      ...usage,
      mode: 'subscription',
      sharedBalance: false,
      primary: { label: '订阅剩余', value: 4, detail: '日 20% · 周 30% · 月 18%' },
    }
    expect(formatDetail(sub, site)).toContain('订阅剩余 $4.0000  日 20% · 周 30% · 月 18%')
  })
})
