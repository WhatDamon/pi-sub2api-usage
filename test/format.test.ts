import { describe, expect, it } from 'vitest'
import {
  FOOTER_MAX_WIDTH,
  PLAIN_PALETTE,
  formatAmount,
  formatCountdown,
  formatDetail,
  formatFooter,
  formatTokens,
  truncateToWidth,
  visibleWidth,
  type FooterState,
  type Palette,
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
  lanes: [],
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

  it('ANSI 转义序列不占可见宽度', () => {
    expect(visibleWidth('\x1b[32m$\x1b[0m')).toBe(1)
    expect(visibleWidth('\x1b[32m$1.88\x1b[0m')).toBe(5)
    expect(visibleWidth('\x1b[32m今日\x1b[0m')).toBe(4)
    expect(visibleWidth('\x1b[1;32mabc\x1b[0m')).toBe(3)
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

  it('max 为 0 或负数时返回空串', () => {
    expect(truncateToWidth('abc', 0)).toBe('')
    expect(truncateToWidth('abc', -1)).toBe('')
  })

  it('不超限时带色文本原样返回，转义字节完整保留', () => {
    expect(truncateToWidth('\x1b[32m$1.88\x1b[0m', 40)).toBe('\x1b[32m$1.88\x1b[0m')
  })

  it('不会截断在转义序列中间', () => {
    const out = truncateToWidth('\x1b[32mabcdefghij\x1b[0m', 5)
    expect(out.startsWith('\x1b[32m')).toBe(true)
    expect(out).toContain('abcde')
    expect(out).not.toMatch(/\x1b\[[0-9;]*$/)
  })

  it('截断时闭合颜色，避免污染同一行的其他扩展状态', () => {
    expect(truncateToWidth('\x1b[32mabcdefghij\x1b[0m', 5)).toBe('\x1b[32mabcde\x1b[0m')
  })

  it('带色文本按可见宽度而非字节数截断', () => {
    const out = truncateToWidth('\x1b[31m今日余额\x1b[0m', 5)
    expect(visibleWidth(out)).toBeLessThanOrEqual(5)
    expect(out).toContain('今日')
  })

  it('OSC 8 超链接不占可见宽度', () => {
    expect(visibleWidth('\x1b]8;;https://gw.example.com\x1b\\Sub2 $1.88\x1b]8;;\x1b\\')).toBe(10) // 'Sub2 $1.88' 是 10 个字符
    expect(visibleWidth('\x1b]8;;https://x\x1b\\abc\x1b]8;;\x1b\\')).toBe(3)
  })

  it('不会截断在 OSC 8 序列中间，且截断时闭合链接', () => {
    const linked = '\x1b]8;;https://gw.example.com\x1b\\Sub2 $1.88\x1b]8;;\x1b\\'
    const out = truncateToWidth(linked, 5)
    expect(visibleWidth(out)).toBeLessThanOrEqual(5)
    expect(out).toContain('\x1b]8;;https://gw.example.com\x1b\\')
    expect(out.endsWith('\x1b]8;;\x1b\\')).toBe(true)
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

  it('位数由调用方决定（余额 2 位、消耗 4 位）', () => {
    expect(formatAmount(1.88485977, 'USD', 2)).toBe('$1.88')
    expect(formatAmount(0.1312296345, 'USD', 2)).toBe('$0.13')
    expect(formatAmount(0.1312296345, 'USD', 4)).toBe('$0.1312')
    expect(formatAmount(1.5, 'CNY', 2)).toBe('¥1.50')
    expect(formatAmount(1.5, 'EUR', 2)).toBe('EUR 1.50')
    expect(formatAmount(null, 'USD', 2)).toBe('—')
  })
})

describe('formatCountdown', () => {
  const now = 1_760_000_000_000
  const at = (ms: number): number => now + ms

  it.each([
    [42 * 60_000, '42m'],
    [3 * 3_600_000, '3h'],
    [3 * 3_600_000 + 12 * 60_000, '3h12m'],
    [2 * 86_400_000, '2d'],
    [2 * 86_400_000 + 3 * 3_600_000, '2d3h'],
    [59 * 60_000 + 59_000, '59m'],
    [30_000, '<1m'],
  ])('剩余 %s ms → %s', (offset, expected) => {
    expect(formatCountdown(at(offset), now)).toBe(expected)
  })

  it('已过期、零剩余或无重置时间时不显示倒计时', () => {
    expect(formatCountdown(now, now)).toBeNull()
    expect(formatCountdown(at(-1), now)).toBeNull()
    expect(formatCountdown(at(-86_400_000), now)).toBeNull()
    expect(formatCountdown(null, now)).toBeNull()
  })
})

describe('PLAIN_PALETTE', () => {
  it('不插入任何 ANSI 序列，供非 TUI 路径与测试使用', () => {
    expect(PLAIN_PALETTE.fg('success', 'x')).toBe('x')
    expect(PLAIN_PALETTE.fg('dim', '$1.88')).toBe('$1.88')
    expect(visibleWidth(PLAIN_PALETTE.fg('error', 'y'))).toBe(1)
  })

  it('Palette 契约：任意 fg 实现都可注入，使色觉断言不必写 ANSI 字面量', () => {
    const tagged: Palette = { fg: (color, text) => `<${color}>${text}</${color}>` }
    expect(tagged.fg('success', 'x')).toBe('<success>x</success>')
    expect(tagged.fg('error', 'y')).toBe('<error>y</error>')
  })})

describe('formatFooter', () => {
  const NOW = 1_760_000_000_000
  const state = (overrides: Partial<NormalizedUsage> = {}, stale = false): FooterState => ({
    kind: 'ok',
    usage: { ...usage, ...overrides },
    stale,
  })
  const lane = (label: string, percent: number | null, resetAt: number | null = null, unlimited = false) => ({
    label,
    percent,
    resetAt,
    unlimited,
  })

  const cases: Array<[string, FooterState, string]> = [
    ['钱包', state(), 'Sub2 $1.88 · Today $0.1312'],
    ['钱包陈旧', state({}, true), 'Sub2 ~$1.88 · Today $0.1312'],
    ['Key 无效', { kind: 'unauthorized' }, 'Sub2 !'],
    ['失败且无旧值', { kind: 'error', usage: null }, 'Sub2 ?'],
    ['失败但有旧值', { kind: 'error', usage }, 'Sub2 ~$1.88 · Today $0.1312'],
    ['未检测到', { kind: 'idle' }, ''],
    ['配额', state({ mode: 'quota', lanes: [lane('', 62)] }), 'Sub2 62%'],
    [
      '订阅',
      state({ mode: 'subscription', lanes: [lane('1d', 20), lane('7d', 30), lane('1m', 18)] }),
      'Sub2 1d 20% · 7d 30% · 1m 18%',
    ],
    [
      '速率限制',
      state({ mode: 'rate_limit', lanes: [lane('5h', 82, NOW + 42 * 60_000)] }),
      'Sub2 5h 82% [⟳ 42m]',
    ],
  ]

  it.each(cases)('%s', (_name, footerState, expected) => {
    expect(formatFooter(footerState, PLAIN_PALETTE, NOW)).toBe(expected)
  })

  it('全部状态的可见宽度都不超过上限', () => {
    for (const [, footerState] of cases) {
      expect(visibleWidth(formatFooter(footerState, PLAIN_PALETTE, NOW))).toBeLessThanOrEqual(FOOTER_MAX_WIDTH)
    }
  })

  it('非钱包形态不带 Today 段', () => {
    const quota = state({ mode: 'quota', lanes: [lane('', 62)] })
    expect(formatFooter(quota, PLAIN_PALETTE, NOW)).not.toContain('Today')
  })

  it('倒计时已过期时整段省略，而不是显示 0', () => {
    const expired = state({ mode: 'rate_limit', lanes: [lane('5h', 82, NOW - 1)] })
    expect(formatFooter(expired, PLAIN_PALETTE, NOW)).toBe('Sub2 5h 82%')
  })

  it('无限订阅窗口显示 unlimited', () => {
    const unlimited = state({ mode: 'subscription', lanes: [lane('1d', null, null, true)] })
    expect(formatFooter(unlimited, PLAIN_PALETTE, NOW)).toBe('Sub2 1d unlimited')
  })

  it('余额缺值时只显示 Today 段', () => {
    const partial = state({ primary: { ...usage.primary, value: null } })
    expect(formatFooter(partial, PLAIN_PALETTE, NOW)).toBe('Sub2 Today $0.1312')
  })

  it('今天的实付为 0 时显示 0 而不是省略', () => {
    const zero = state({ today: { ...usage.today!, actualCost: 0 } })
    expect(formatFooter(zero, PLAIN_PALETTE, NOW)).toBe('Sub2 $1.88 · Today $0.0000')
  })

  it('PLAIN_PALETTE 下输出不含任何 ANSI 序列', () => {
    for (const [, footerState] of cases) {
      expect(formatFooter(footerState, PLAIN_PALETTE, NOW)).not.toMatch(/\x1b\[/)
    }
  })
})

describe('formatFooter 的着色', () => {
  const NOW = 1_760_000_000_000

  /**
   * 用真实的零宽 SGR 序列打标。不能用 `<success>…` 这种可见标记：
   * 标记自身会占可见宽度，让 40 列截断把断言内容切掉；零宽序列才能穿透截断。
   */
  const SGR: Record<string, string> = {
    success: '\x1b[32m',
    warning: '\x1b[33m',
    error: '\x1b[31m',
    dim: '\x1b[2m',
    text: '\x1b[39m',
  }
  const painted = (color: string, text: string): string => `${SGR[color] ?? ''}${text}\x1b[0m`
  const tagged: Palette = { fg: (color, text) => painted(color, text) }

  const render = (overrides: Partial<NormalizedUsage>): string =>
    formatFooter({ kind: 'ok', usage: { ...usage, ...overrides }, stale: false }, tagged, NOW)
  const atBalance = (value: number, unit = 'USD'): string =>
    render({ unit, primary: { ...usage.primary, value } })
  const atPercent = (percent: number): string =>
    render({ mode: 'rate_limit', lanes: [{ label: '5h', percent, resetAt: null, unlimited: false }] })

  it('钱包余额 <$0.5 用 error、<$2 用 warning、否则 success', () => {
    expect(atBalance(5)).toContain(painted('success', '$5.00'))
    expect(atBalance(1.88)).toContain(painted('warning', '$1.88'))
    expect(atBalance(0.4)).toContain(painted('error', '$0.40'))
  })

  it('阀值不是 USD 时不做严重性判断，用默认色', () => {
    expect(atBalance(0.2, 'CNY')).toContain(painted('text', '¥0.20'))
  })

  it('窗口百分比 70% 起 warning、90% 起 error', () => {
    expect(atPercent(69)).toContain(painted('success', '69%'))
    expect(atPercent(70)).toContain(painted('warning', '70%'))
    expect(atPercent(89)).toContain(painted('warning', '89%'))
    expect(atPercent(90)).toContain(painted('error', '90%'))
  })

  it('标签与 Today 段用 dim 弱化，只有数字跳出来', () => {
    const out = formatFooter({ kind: 'ok', usage, stale: false }, tagged, NOW)
    expect(out.startsWith(`${painted('dim', 'Sub2')} `)).toBe(true)
    expect(out).toContain(painted('dim', 'Today $0.1312'))
  })

  it('窗口标签用 dim、百分比用严重性色、倒计时用 dim', () => {
    const out = render({
      mode: 'rate_limit',
      lanes: [{ label: '5h', percent: 82, resetAt: NOW + 42 * 60_000, unlimited: false }],
    })
    expect(out).toBe(
      `${painted('dim', 'Sub2')} ${painted('dim', '5h')} ${painted('warning', '82%')} ${painted('dim', '[⟳ 42m]')}`,
    )
  })

  it('Key 无效与失败态整段用 error', () => {
    expect(formatFooter({ kind: 'unauthorized' }, tagged, NOW)).toBe(painted('error', 'Sub2 !'))
    expect(formatFooter({ kind: 'error', usage: null }, tagged, NOW)).toBe(painted('error', 'Sub2 ?'))
    expect(formatFooter({ kind: 'idle' }, tagged, NOW)).toBe('')
  })

  it('带色输出的可见宽度仍然受 40 列约束', () => {
    const long = render({
      mode: 'subscription',
      lanes: [
        { label: '1d', percent: 20, resetAt: null, unlimited: false },
        { label: '7d', percent: 30, resetAt: null, unlimited: false },
        { label: '1m', percent: 18, resetAt: null, unlimited: false },
      ],
    })
    expect(visibleWidth(long)).toBeLessThanOrEqual(FOOTER_MAX_WIDTH)
  })
})

describe('formatDetail', () => {
  it('钱包形态的完整输出', () => {
    expect(formatDetail(usage, site)).toBe(
      [
        'sub2api · site-a',
        'https://gw.example.com',
        '钱包余额（多 Key 共享） $1.88',
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
    expect(formatDetail(sub, site)).toContain('订阅剩余 $4.00  日 20% · 周 30% · 月 18%')
  })
})
