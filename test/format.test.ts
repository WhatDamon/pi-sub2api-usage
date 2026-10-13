import { describe, expect, it } from 'vitest'
import {
  FOOTER_MAX_WIDTH,
  PLAIN_PALETTE,
  formatAmount,
  formatCountdown,
  formatDetail,
  formatFooter,
  formatPrimary,
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
  unit: 'USD',
  primary: {
    label: 'Wallet balance (shared across keys)',
    value: 1.88485977,
    format: 'amount',
    detail: undefined,
  },
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
  lanes: [],
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
  it('counts ASCII as 1 column, CJK as 2, and combining marks as 0', () => {
    expect(visibleWidth('sub2 $1.88')).toBe(10)
    expect(visibleWidth('今日')).toBe(4)
    expect(visibleWidth('今 $1.88')).toBe(8)
    expect(visibleWidth('e\u0301')).toBe(1)
    expect(visibleWidth('（原价）')).toBe(8)
  })

  it('ANSI escape sequences take no visible width', () => {
    expect(visibleWidth('\x1b[32m$\x1b[0m')).toBe(1)
    expect(visibleWidth('\x1b[32m$1.88\x1b[0m')).toBe(5)
    expect(visibleWidth('\x1b[32m今日\x1b[0m')).toBe(4)
    expect(visibleWidth('\x1b[1;32mabc\x1b[0m')).toBe(3)
  })
})

describe('truncateToWidth', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncateToWidth('abc', 5)).toBe('abc')
  })

  it('truncates by visible width when it overflows', () => {
    expect(truncateToWidth('abcde', 3)).toBe('abc')
  })

  it('never cuts a CJK character in half', () => {
    expect(visibleWidth(truncateToWidth('今日余额', 5))).toBeLessThanOrEqual(5)
    expect(truncateToWidth('今日余额', 5)).toBe('今日')
  })

  it('returns an empty string when max is 0 or negative', () => {
    expect(truncateToWidth('abc', 0)).toBe('')
    expect(truncateToWidth('abc', -1)).toBe('')
  })

  it('returns coloured text unchanged when it fits, keeping every escape byte intact', () => {
    expect(truncateToWidth('\x1b[32m$1.88\x1b[0m', 40)).toBe('\x1b[32m$1.88\x1b[0m')
  })

  it('never truncates in the middle of an escape sequence', () => {
    const out = truncateToWidth('\x1b[32mabcdefghij\x1b[0m', 5)
    expect(out.startsWith('\x1b[32m')).toBe(true)
    expect(out).toContain('abcde')
    expect(out).not.toMatch(/\x1b\[[0-9;]*$/)
  })

  it('closes the colour on truncation so it cannot leak into another extension on the same line', () => {
    expect(truncateToWidth('\x1b[32mabcdefghij\x1b[0m', 5)).toBe('\x1b[32mabcde\x1b[0m')
  })

  it('truncates coloured text by visible width, not by byte count', () => {
    const out = truncateToWidth('\x1b[31m今日余额\x1b[0m', 5)
    expect(visibleWidth(out)).toBeLessThanOrEqual(5)
    expect(out).toContain('今日')
  })

  it('OSC 8 hyperlinks take no visible width', () => {
    expect(visibleWidth('\x1b]8;;https://gw.example.com\x1b\\Sub2 $1.88\x1b]8;;\x1b\\')).toBe(10) // 'Sub2 $1.88' is 10 characters
    expect(visibleWidth('\x1b]8;;https://x\x1b\\abc\x1b]8;;\x1b\\')).toBe(3)
  })

  it('never truncates inside an OSC 8 sequence and closes the link when cutting', () => {
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

  it('renders null as a dash', () => {
    expect(formatTokens(null)).toBe('—')
  })
})

describe('formatAmount', () => {
  it('uses the dollar sign for USD with 4 decimals', () => {
    expect(formatAmount(1.88485977, 'USD')).toBe('$1.8849')
    expect(formatAmount(0, 'USD')).toBe('$0.0000')
  })

  it('uses the yuan sign for CNY', () => {
    expect(formatAmount(1.5, 'CNY')).toBe('¥1.5000')
  })

  it('prefixes the unit name for an unknown unit', () => {
    expect(formatAmount(1.5, 'EUR')).toBe('EUR 1.5000')
  })

  it('renders null as a dash', () => {
    expect(formatAmount(null, 'USD')).toBe('—')
  })

  it('lets the caller choose the digit count (2 for balance, 4 for spend)', () => {
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
  ])('remaining %s ms -> %s', (offset, expected) => {
    expect(formatCountdown(at(offset), now)).toBe(expected)
  })

  it('shows no countdown when expired, at zero remaining, or with no reset time', () => {
    expect(formatCountdown(now, now)).toBeNull()
    expect(formatCountdown(at(-1), now)).toBeNull()
    expect(formatCountdown(at(-86_400_000), now)).toBeNull()
    expect(formatCountdown(null, now)).toBeNull()
  })
})

describe('PLAIN_PALETTE', () => {
  it('inserts no ANSI at all, for non-TUI paths and tests', () => {
    expect(PLAIN_PALETTE.fg('success', 'x')).toBe('x')
    expect(PLAIN_PALETTE.fg('dim', '$1.88')).toBe('$1.88')
    expect(visibleWidth(PLAIN_PALETTE.fg('error', 'y'))).toBe(1)
  })

  it('Palette contract: any fg implementation can be injected, so colour assertions need no ANSI literals', () => {
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
    ['wallet', state(), 'Sub2 $1.88 · Today $0.1312'],
    ['stale wallet', state({}, true), 'Sub2 ~$1.88 · Today $0.1312'],
    ['invalid key', { kind: 'unauthorized' }, 'Sub2 !'],
    ['failure with no cached value', { kind: 'error', usage: null }, 'Sub2 ?'],
    ['failure with a cached value', { kind: 'error', usage }, 'Sub2 ~$1.88 · Today $0.1312'],
    ['not detected', { kind: 'idle' }, ''],
    ['quota', state({ mode: 'quota', lanes: [lane('', 62)] }), 'Sub2 62%'],
    [
      'subscription',
      state({ mode: 'subscription', lanes: [lane('1d', 20), lane('7d', 30), lane('1m', 18)] }),
      'Sub2 1d 20% · 7d 30% · 1m 18%',
    ],
    [
      'rate limit',
      state({ mode: 'rate_limit', lanes: [lane('5h', 82, NOW + 42 * 60_000)] }),
      'Sub2 5h 82% [⟳ 42m]',
    ],
  ]

  it.each(cases)('%s', (_name, footerState, expected) => {
    expect(formatFooter(footerState, PLAIN_PALETTE, NOW)).toBe(expected)
  })

  it('keeps every state within the visible width cap', () => {
    for (const [, footerState] of cases) {
      expect(visibleWidth(formatFooter(footerState, PLAIN_PALETTE, NOW))).toBeLessThanOrEqual(FOOTER_MAX_WIDTH)
    }
  })

  it('drops whole segments instead of cutting one in half when the line is too long', () => {
    // Two windows whose countdowns together overflow the cap. Plain truncation stops at
    // column 40, which here lands on the final bracket — leaving "[⟳ 29d12h" on screen.
    const crowded = state({
      mode: 'rate_limit',
      lanes: [
        lane('5h', 82, NOW + 3 * 3_600_000 + 12 * 60_000),
        lane('1d', 75, NOW + 29 * 86_400_000 + 12 * 3_600_000),
      ],
    })
    const out = formatFooter(crowded, PLAIN_PALETTE, NOW)
    expect(visibleWidth(out)).toBeLessThanOrEqual(FOOTER_MAX_WIDTH)
    expect((out.match(/\[/g) ?? []).length).toBe((out.match(/\]/g) ?? []).length)
    expect(out).toBe('Sub2 5h 82% [⟳ 3h12m]')
  })

  it('omits the Today segment for non-wallet modes', () => {
    const quota = state({ mode: 'quota', lanes: [lane('', 62)] })
    expect(formatFooter(quota, PLAIN_PALETTE, NOW)).not.toContain('Today')
  })

  it('omits the whole countdown when expired rather than showing 0', () => {
    const expired = state({ mode: 'rate_limit', lanes: [lane('5h', 82, NOW - 1)] })
    expect(formatFooter(expired, PLAIN_PALETTE, NOW)).toBe('Sub2 5h 82%')
  })

  it('renders unlimited for an uncapped subscription window', () => {
    const unlimited = state({ mode: 'subscription', lanes: [lane('1d', null, null, true)] })
    expect(formatFooter(unlimited, PLAIN_PALETTE, NOW)).toBe('Sub2 1d unlimited')
  })

  it('shows only the Today segment when the balance is missing', () => {
    const partial = state({ primary: { ...usage.primary, value: null } })
    expect(formatFooter(partial, PLAIN_PALETTE, NOW)).toBe('Sub2 Today $0.1312')
  })

  it('shows 0 rather than omitting when today spend is exactly 0', () => {
    const zero = state({ today: { ...usage.today!, actualCost: 0 } })
    expect(formatFooter(zero, PLAIN_PALETTE, NOW)).toBe('Sub2 $1.88 · Today $0.0000')
  })

  it('PLAIN_PALETTE output contains no ANSI at all', () => {
    for (const [, footerState] of cases) {
      expect(formatFooter(footerState, PLAIN_PALETTE, NOW)).not.toMatch(/\x1b\[/)
    }
  })
})

describe('formatFooter colouring', () => {
  const NOW = 1_760_000_000_000

  /**
   * Tag with real zero-width SGR sequences. Visible markers like `<success>...` cannot be used:
   * the marker itself occupies visible width, so the 40-column truncation cuts the assertion
   * content away; only zero-width sequences survive truncation.
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

  it('balance <$0.5 error, <$2 warning, otherwise success', () => {
    expect(atBalance(5)).toContain(painted('success', '$5.00'))
    expect(atBalance(1.88)).toContain(painted('warning', '$1.88'))
    expect(atBalance(0.4)).toContain(painted('error', '$0.40'))
  })

  it('makes no severity judgement when the unit is not USD; uses the default colour', () => {
    expect(atBalance(0.2, 'CNY')).toContain(painted('text', '¥0.20'))
  })

  it('window percentages warn from 70% and error from 90%', () => {
    expect(atPercent(69)).toContain(painted('success', '69%'))
    expect(atPercent(70)).toContain(painted('warning', '70%'))
    expect(atPercent(89)).toContain(painted('warning', '89%'))
    expect(atPercent(90)).toContain(painted('error', '90%'))
  })

  it('de-emphasises the label and Today segment with dim so the numbers stand out', () => {
    const out = formatFooter({ kind: 'ok', usage, stale: false }, tagged, NOW)
    expect(out.startsWith(`${painted('dim', 'Sub2')} `)).toBe(true)
    expect(out).toContain(painted('dim', 'Today $0.1312'))
  })

  it('paints the separator between segments dim too, so it does not stand out as default-coloured text', () => {
    const separator = painted('dim', ' · ')
    const count = (text: string): number => text.split(separator).length - 1

    // Wallet mode has two segments (balance + Today), so exactly one separator.
    expect(count(formatFooter({ kind: 'ok', usage, stale: false }, tagged, NOW))).toBe(1)

    // Subscription mode has three lanes, so two separators.
    const subscription = render({
      mode: 'subscription',
      lanes: [
        { label: '1d', percent: 20, resetAt: null, unlimited: false },
        { label: '7d', percent: 30, resetAt: null, unlimited: false },
        { label: '1m', percent: 18, resetAt: null, unlimited: false },
      ],
    })
    expect(count(subscription)).toBe(2)
  })

  it('window labels dim, percentages in the severity colour, countdown dim', () => {
    const out = render({
      mode: 'rate_limit',
      lanes: [{ label: '5h', percent: 82, resetAt: NOW + 42 * 60_000, unlimited: false }],
    })
    expect(out).toBe(
      `${painted('dim', 'Sub2')} ${painted('dim', '5h')} ${painted('warning', '82%')} ${painted('dim', '[⟳ 42m]')}`,
    )
  })

  it('renders the whole line with error for an invalid key and failure states', () => {
    expect(formatFooter({ kind: 'unauthorized' }, tagged, NOW)).toBe(painted('error', 'Sub2 !'))
    expect(formatFooter({ kind: 'error', usage: null }, tagged, NOW)).toBe(painted('error', 'Sub2 ?'))
    expect(formatFooter({ kind: 'idle' }, tagged, NOW)).toBe('')
  })

  it('keeps coloured output within the 40-column cap too', () => {
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
  it('full wallet-mode output', () => {
    expect(formatDetail(usage, site)).toBe(
      [
        'sub2api · site-a',
        'https://gw.example.com',
        'Wallet balance (shared across keys) $1.88',
        'Today 137 req · 19.3M tok · spend $0.1312 (list $0.5249)',
        'Total 1326 req · 127.1M tok · spend $0.9151 (list $3.6606)',
        'Last 3d 10-09 $0.0199 · 10-10 $0.3104 · 10-11 $0.1312',
        'By model m-1 $0.9118 · 127.1M tok · 1324 req · m-2 $0.0033 · 1.0K tok · 2 req · m-3 $0.0001 · 10 tok · 1 req',
      ].join('\n'),
    )
  })

  it('omits the line when daily is missing', () => {
    const out = formatDetail({ ...usage, daily: [], byModel: [] }, site)
    expect(out.split('\n')).toHaveLength(5)
    expect(out).not.toContain('Last 3d')
  })

  it('renders the primary detail for subscription mode', () => {
    const sub: NormalizedUsage = {
      ...usage,
      mode: 'subscription',
      primary: { label: 'Subscription left', value: 4, format: 'amount', detail: '1d 20% · 7d 30% · 1m 18%' },
    }
    expect(formatDetail(sub, site)).toContain('Subscription left $4.00  1d 20% · 7d 30% · 1m 18%')
  })

  it('renders a rate-limit window as a request count rather than as dollars', () => {
    const rateLimited: NormalizedUsage = {
      ...usage,
      mode: 'rate_limit',
      primary: { label: '5h window left', value: 18, format: 'count', detail: '5h 82% · 1d 75%' },
    }
    expect(formatDetail(rateLimited, site)).toContain('5h window left 18  5h 82% · 1d 75%')
    expect(formatDetail(rateLimited, site)).not.toContain('$18.00')
  })

  it('omits the request count for a model whose count is unknown instead of printing 0 req', () => {
    const out = formatDetail(
      { ...usage, byModel: [{ model: 'm-1', requests: null, totalTokens: 100, actualCost: 0.5 }] },
      site,
    )
    expect(out).toContain('By model m-1 $0.5000 · 100 tok')
    expect(out).not.toContain('0 req')
  })
})

describe('formatPrimary', () => {
  it('renders an amount at balance precision, not the 4-decimal spend precision', () => {
    expect(formatPrimary(usage)).toBe('$1.88')
  })

  it('renders a count as a bare integer, never as currency', () => {
    const rateLimited: NormalizedUsage = {
      ...usage,
      mode: 'rate_limit',
      primary: { label: '5h window left', value: 18, format: 'count', detail: '5h 82%' },
    }
    expect(formatPrimary(rateLimited)).toBe('18')
  })

  it('renders an unknown value as a dash in both formats', () => {
    expect(formatPrimary({ ...usage, primary: { ...usage.primary, value: null } })).toBe('—')
    const unknownCount: NormalizedUsage = {
      ...usage,
      primary: { ...usage.primary, value: null, format: 'count' },
    }
    expect(formatPrimary(unknownCount)).toBe('—')
  })
})
