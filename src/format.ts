import type { SiteCredential } from './config.ts'
import type { NormalizedUsage, UsageBucket, UsageLane } from './normalize.ts'

export const FOOTER_MAX_WIDTH = 40
export const FOOTER_STATUS_KEY = 'sub2api-usage'

export type FooterState =
  | { kind: 'ok'; usage: NormalizedUsage; stale: boolean }
  | { kind: 'unauthorized' }
  | { kind: 'error'; usage: NormalizedUsage | null }
  | { kind: 'idle' }

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', CNY: '¥' }

/**
 * Semantic colour callback. Pi's `Theme` (`fg(color, text)`) satisfies this type
 * structurally, so the footer can be coloured from the live theme while tests can
 * inject a tagging palette to assert colour choices precisely, without writing
 * brittle ANSI literals into every assertion.
 */
export type Palette = {
  fg(color: 'success' | 'warning' | 'error' | 'dim' | 'text', text: string): string
}

/** Identity palette: used by non-TUI paths and tests; its output contains no ANSI at all. */
export const PLAIN_PALETTE: Palette = { fg: (_color, text) => text }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** The footer is always English (shorter, and easier to read alongside other extensions' statuses). */
const FOOTER_PREFIX = 'Sub2'

/** Balance keeps 2 decimals for an at-a-glance overview; spend keeps 4, because one turn often costs $0.001-$0.01 and 2 decimals would render $0.00. */
const BALANCE_DIGITS = 2
const COST_DIGITS = 4

/**
 * Balance thresholds (USD only). Sized for a small prepaid wallet rather than the
 * $10/$5 used by large-account balance displays: a typical sub2api balance sits at
 * a few dollars, so copying those numbers would keep the footer permanently red and
 * drain it of signal.
 */
const BALANCE_WARNING_USD = 2
const BALANCE_ERROR_USD = 0.5

/** Window thresholds: warn from 70% used, error from 90%. */
const LANE_WARNING_PERCENT = 70
const LANE_ERROR_PERCENT = 90

type SeverityColor = 'success' | 'warning' | 'error'

/** Absolute thresholds only mean something in USD; for an unknown unit we do not guess and use the default colour. */
function balanceColor(value: number, unit: string): SeverityColor | 'text' {
  if (unit !== 'USD') return 'text'
  if (value < BALANCE_ERROR_USD) return 'error'
  if (value < BALANCE_WARNING_USD) return 'warning'
  return 'success'
}

function laneColor(percent: number): SeverityColor {
  if (percent >= LANE_ERROR_PERCENT) return 'error'
  if (percent >= LANE_WARNING_PERCENT) return 'warning'
  return 'success'
}

/** One window: `1d 20%` / `5h 82% [⟳ 42m]` / `1d unlimited`. */
function renderLane(lane: UsageLane, palette: Palette, now: number): string {
  const label = lane.label === '' ? '' : `${palette.fg('dim', lane.label)} `
  if (lane.unlimited) return `${label}${palette.fg('dim', 'unlimited')}`
  if (lane.percent === null) return `${label}${palette.fg('dim', '?')}`

  const countdown = formatCountdown(lane.resetAt, now)
  const reset = countdown === null ? '' : ` ${palette.fg('dim', `[⟳ ${countdown}]`)}`
  return `${label}${palette.fg(laneColor(lane.percent), `${Math.round(lane.percent)}%`)}${reset}`
}

/** East Asian full-width ranges. A hit occupies 2 columns. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
]

function charWidth(char: string): number {
  if (/\p{M}/u.test(char)) return 0
  const codePoint = char.codePointAt(0) ?? 0
  for (const [low, high] of WIDE_RANGES) {
    if (codePoint >= low && codePoint <= high) return 2
  }
  return codePoint >= 0x20000 ? 2 : 1
}

/** Matches one ANSI SGR sequence such as `\x1b[32m`, `\x1b[1;32m` or `\x1b[0m`. */
const SGR_PATTERN = /^\x1b\[[0-9;]*m/

/**
 * Matches one OSC 8 hyperlink such as `\x1b]8;;URL\x1b\\` (the closing sequence
 * carries an empty URL).
 *
 * OSC 8 is **not** zero-width the way SGR is: without recognising it, every character
 * of the URL would count as a visible column and the footer width limit would be
 * meaningless.
 */
const OSC8_PATTERN = /^\x1b\]8;;([^\x1b\x07]*)(?:\x1b\\|\x07)/

const LINK_CLOSE = '\x1b]8;;\x1b\\'

type EscapeKind = 'open' | 'reset' | 'link-open' | 'link-close'

interface Escape {
  text: string
  kind: EscapeKind
}

/** `\x1b[0m`, `\x1b[m` and `\x1b[0;0m` are all resets; any other SGR counts as opening a style. */
function isResetSgr(sgr: string): boolean {
  return sgr
    .slice(2, -1)
    .split(';')
    .every((part) => part === '' || part === '0')
}

/** Recognises the escape sequence at `index`; returns null when there is none. */
function escapeAt(text: string, index: number): Escape | null {
  const slice = text.slice(index)

  const sgr = SGR_PATTERN.exec(slice)
  if (sgr !== null) return { text: sgr[0], kind: isResetSgr(sgr[0]) ? 'reset' : 'open' }

  const osc = OSC8_PATTERN.exec(slice)
  if (osc !== null) return { text: osc[0], kind: (osc[1] ?? '') === '' ? 'link-close' : 'link-open' }

  return null
}

/**
 * Terminal visible width. **`String.length` cannot be used here** — CJK characters
 * take 2 columns, combining marks take 0, and ANSI colour plus OSC 8 links take 0.
 * Getting any one of those wrong makes the footer width limit meaningless.
 */
export function visibleWidth(text: string): number {
  let total = 0
  let index = 0

  while (index < text.length) {
    const escape = escapeAt(text, index)
    if (escape !== null) {
      index += escape.text.length
      continue
    }
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0)
    total += charWidth(char)
    index += char.length
  }

  return total
}

/**
 * Truncate to a visible width, never emitting half a full-width character and never
 * cutting an escape sequence in two.
 *
 * If a colour or hyperlink is still open at the cut it must be closed explicitly:
 * Pi joins every extension's status into one line with spaces, so an unclosed colour
 * would leak onto whatever another extension renders after us.
 */
export function truncateToWidth(text: string, max: number): string {
  if (max <= 0) return ''

  let total = 0
  let out = ''
  let index = 0
  let styleOpen = false
  let linkOpen = false

  const close = (): string => `${linkOpen ? LINK_CLOSE : ''}${styleOpen ? '\x1b[0m' : ''}`

  while (index < text.length) {
    const escape = escapeAt(text, index)
    if (escape !== null) {
      out += escape.text
      if (escape.kind === 'open') styleOpen = true
      else if (escape.kind === 'reset') styleOpen = false
      else if (escape.kind === 'link-open') linkOpen = true
      else linkOpen = false
      index += escape.text.length
      continue
    }

    const char = String.fromCodePoint(text.codePointAt(index) ?? 0)
    const width = charWidth(char)
    if (total + width > max) return out + close()
    total += width
    out += char
    index += char.length
  }

  return out
}

export function formatAmount(value: number | null, unit = 'USD', digits = 4): string {
  if (value === null) return '—'
  const amount = value.toFixed(digits)
  const symbol = CURRENCY_SYMBOLS[unit]
  return symbol === undefined ? `${unit} ${amount}` : `${symbol}${amount}`
}

/**
 * Reset countdown in a compact format (`42m` / `3h12m` / `2d3h`).
 *
 * Returns `null` when already expired or when there is no reset time, so the caller
 * omits the segment entirely rather than printing a `0` that reads as "just reset".
 */
export function formatCountdown(resetAt: number | null, now: number): string | null {
  if (resetAt === null) return null
  const remaining = resetAt - now
  if (remaining <= 0) return null
  if (remaining < MINUTE_MS) return '<1m'

  const days = Math.floor(remaining / DAY_MS)
  const hours = Math.floor((remaining % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS)

  if (days > 0) return hours === 0 ? `${days}d` : `${days}d${hours}h`
  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`
  return `${minutes}m`
}

export function formatTokens(value: number | null): string {
  if (value === null) return '—'
  if (value < 1_000) return String(value)
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  return `${(value / 1_000).toFixed(1)}K`
}

function costPart(bucket: UsageBucket, unit: string): string | null {
  const actual = bucket.actualCost
  const original = bucket.cost

  if (actual !== null && original !== null) {
    return `spend ${formatAmount(actual, unit)} (list ${formatAmount(original, unit)})`
  }
  if (actual !== null) return `spend ${formatAmount(actual, unit)}`
  if (original !== null) return `list ${formatAmount(original, unit)}`
  return null
}

function usageLine(label: string, bucket: UsageBucket | null, unit: string): string | null {
  if (!bucket || bucket.requests === null) return null
  const head = `${label} ${bucket.requests} req · ${formatTokens(bucket.totalTokens)} tok`
  const costs = costPart(bucket, unit)
  return costs === null ? head : `${head} · ${costs}`
}

export function formatFooter(state: FooterState, palette: Palette, now: number): string {
  if (state.kind === 'idle') return ''
  if (state.kind === 'unauthorized') return palette.fg('error', `${FOOTER_PREFIX} !`)
  if (state.usage === null) return palette.fg('error', `${FOOTER_PREFIX} ?`)

  const usage = state.usage
  const stale = state.kind === 'ok' ? state.stale : true
  const segments: string[] = []

  if (usage.mode === 'wallet') {
    if (usage.primary.value !== null) {
      const amount = formatAmount(usage.primary.value, usage.unit, BALANCE_DIGITS)
      segments.push(palette.fg(balanceColor(usage.primary.value, usage.unit), amount))
    }

    // A wallet is pay-as-you-go, so the burn rate matters most: hence the Today
    // segment. Cap-based modes lead with window percentages and share no "balance"
    // concept, so they omit Today (it is still available in the detail).
    const todayCost = usage.today?.actualCost ?? null
    if (todayCost !== null) {
      segments.push(palette.fg('dim', `Today ${formatAmount(todayCost, usage.unit, COST_DIGITS)}`))
    }
  } else {
    for (const lane of usage.lanes) segments.push(renderLane(lane, palette, now))
  }

  if (segments.length === 0) return palette.fg('error', `${FOOTER_PREFIX} ?`)

  const label = palette.fg('dim', FOOTER_PREFIX)
  // The joiner is painted dim as well. Left bare it would render in the terminal's
  // default foreground, leaving a bright dot sitting between two dim segments.
  const separator = palette.fg('dim', ' · ')
  return truncateToWidth(`${label} ${stale ? '~' : ''}${segments.join(separator)}`, FOOTER_MAX_WIDTH)
}

export function formatDetail(usage: NormalizedUsage, site: SiteCredential): string {
  const balance = (value: number | null): string => formatAmount(value, usage.unit, BALANCE_DIGITS)
  const amount = (value: number | null): string => formatAmount(value, usage.unit, COST_DIGITS)
  const lines: string[] = []

  lines.push(`sub2api · ${site.provider}`)
  lines.push(site.baseUrl)

  const primary = `${usage.primary.label} ${balance(usage.primary.value)}`
  lines.push(usage.primary.detail === undefined ? primary : `${primary}  ${usage.primary.detail}`)

  const today = usageLine('Today', usage.today, usage.unit)
  if (today !== null) lines.push(today)

  const total = usageLine('Total', usage.total, usage.unit)
  if (total !== null) lines.push(total)

  if (usage.daily.length > 0) {
    const recent = usage.daily.slice(-3)
    const cells = recent.map((day) => `${day.date.slice(5)} ${amount(day.actualCost)}`)
    lines.push(`Last ${recent.length}d ${cells.join(' · ')}`)
  }

  if (usage.byModel.length > 0) {
    const groups = usage.byModel.slice(0, 3).map((entry) => {
      const cells = `${amount(entry.actualCost)} · ${formatTokens(entry.totalTokens)} tok · ${entry.requests ?? 0} req`
      return `${entry.model} ${cells}`
    })
    lines.push(`By model ${groups.join(' · ')}`)
  }

  return lines.filter((line) => line !== '').join('\n')
}
