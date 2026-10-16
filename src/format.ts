/**
 * Width and truncation are delegated to pi-tui rather than reimplemented here.
 *
 * `String.length` is unusable for this: CJK takes 2 columns, combining marks take 0, and
 * ANSI colour plus OSC 8 links take 0. Getting that right needs grapheme segmentation and
 * emoji width tables, which pi-tui already has and which this package already depends on —
 * so the footer now measures the same way the rest of the UI does.
 *
 * `truncateToWidth(text, max, '')` is the contract used below: no ellipsis, and when it
 * actually cuts it closes any open hyperlink and emits an SGR reset, so our segment cannot
 * leak colour onto another extension's status text further along the same line.
 */
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
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

export function formatAmount(value: number | null, unit = 'USD', digits = 4): string {
  if (value === null) return '—'
  const amount = value.toFixed(digits)
  const symbol = CURRENCY_SYMBOLS[unit]
  return symbol === undefined ? `${unit} ${amount}` : `${symbol}${amount}`
}

/**
 * The primary value rendered in its own terms.
 *
 * Not every primary value is money: in rate-limit mode it counts requests, and running a
 * count through the currency formatter turns "18 requests left" into `$18.00`. Keeping
 * this in one place is also what stops `/sub2-usage` and its candidate list from
 * disagreeing about precision.
 */
export function formatPrimary(usage: NormalizedUsage): string {
  const value = usage.primary.value
  if (usage.primary.format === 'count') return value === null ? '—' : String(value)
  return formatAmount(value, usage.unit, BALANCE_DIGITS)
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

/**
 * `2026-10-11` → `10-11`, and an ISO datetime → `10-11` as well.
 *
 * The wire layout is not enforced anywhere, so dropping a fixed five characters would
 * print `10-11T00:00:00Z` for a datetime and would mangle any other ordering. Anything
 * that is not an ISO date (or datetime) is passed through unchanged: a date we cannot
 * parse is still a date the backend reported, and `—` would throw that away.
 */
function shortDate(date: string): string {
  return date.replace(/^\d{4}-(\d{2}-\d{2})(?:[T ].*)?$/, '$1')
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

  // Add whole segments while they fit. Plain truncation stops mid-segment, which can cut
  // a countdown in half and leave an unclosed bracket on screen.
  let out = `${label} `
  let placed = 0
  for (const segment of segments) {
    const prefix = placed === 0 ? (stale ? '~' : '') : separator
    const candidate = `${out}${prefix}${segment}`
    if (visibleWidth(candidate) > FOOTER_MAX_WIDTH) break
    out = candidate
    placed += 1
  }

  // Nothing fitted at all, and a bare label carries no information: fall back to plain
  // truncation so as much of the first segment as possible is still shown.
  if (placed === 0) {
    return truncateToWidth(`${label} ${stale ? '~' : ''}${segments.join(separator)}`, FOOTER_MAX_WIDTH, '')
  }

  // `out` was built to fit, so this is normally a no-op; it stays as a guard for the case
  // where a single segment is itself wider than the limit.
  return truncateToWidth(out, FOOTER_MAX_WIDTH, '')
}

export function formatDetail(usage: NormalizedUsage, site: SiteCredential): string {
  const amount = (value: number | null): string => formatAmount(value, usage.unit, COST_DIGITS)
  const lines: string[] = []

  lines.push(`sub2api · ${site.provider}`)
  lines.push(site.baseUrl)

  // `formatPrimary` decides between an amount and a count; spend always renders at
  // COST_DIGITS, which is why the two are no longer the same helper.
  const primary = `${usage.primary.label} ${formatPrimary(usage)}`
  lines.push(usage.primary.detail === undefined ? primary : `${primary}  ${usage.primary.detail}`)

  const today = usageLine('Today', usage.today, usage.unit)
  if (today !== null) lines.push(today)

  const total = usageLine('Total', usage.total, usage.unit)
  if (total !== null) lines.push(total)

  if (usage.daily.length > 0) {
    const recent = usage.daily.slice(-3)
    const cells = recent.map((day) => `${shortDate(day.date)} ${amount(day.actualCost)}`)
    lines.push(`Last ${recent.length}d ${cells.join(' · ')}`)
  }

  if (usage.byModel.length > 0) {
    const groups = usage.byModel.slice(0, 3).map((entry) => {
      // An unknown request count is left out rather than printed as "0 req", which would
      // be a number the backend never reported.
      const cells = [
        amount(entry.actualCost),
        `${formatTokens(entry.totalTokens)} tok`,
        entry.requests === null ? null : `${entry.requests} req`,
      ].filter((cell): cell is string => cell !== null)
      return `${entry.model} ${cells.join(' · ')}`
    })
    lines.push(`By model ${groups.join(' · ')}`)
  }

  return lines.filter((line) => line !== '').join('\n')
}
