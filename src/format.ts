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
 * 语义化配色回调。Pi 的 `Theme`（`fg(color, text)`）结构上直接满足此类型，
 * 所以 footer 能用实时主题着色，而测试可以注入打标调色板精确断言颜色选择，
 * 不必在每条断言里写脆弱的 ANSI 字面量。
 */
export type Palette = {
  fg(color: 'success' | 'warning' | 'error' | 'dim' | 'text', text: string): string
}

/** 恒等调色板：非 TUI 路径与测试使用，输出不含任何 ANSI 序列。 */
export const PLAIN_PALETTE: Palette = { fg: (_color, text) => text }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** footer 一律英文（内容短、和其他扩展的状态并排时更好读）。 */
const FOOTER_PREFIX = 'Sub2'

/** 余额 2 位看概览；消耗 4 位——单轮消耗常在 $0.001~$0.01 量级，2 位会显示成 $0.00。 */
const BALANCE_DIGITS = 2
const COST_DIGITS = 4

/**
 * 余额阀值（仅 USD）。取小额预付费钱包的量级，而非 DeepSeek 那套面向大账户的
 * $10/$5：sub2api 站点常见余额就在几美元，照搬会让 footer 永久发红而失去信息量。
 */
const BALANCE_WARNING_USD = 2
const BALANCE_ERROR_USD = 0.5

/** 窗口阀值：已用 70% 提醒、90% 告警。 */
const LANE_WARNING_PERCENT = 70
const LANE_ERROR_PERCENT = 90

type SeverityColor = 'success' | 'warning' | 'error'

/** 绝对阀值只在 USD 下有意义；未知币种不做臆断，用默认色。 */
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

/** 一个窗口：`1d 20%` / `5h 82% [⟳ 42m]` / `1d unlimited`。 */
function renderLane(lane: UsageLane, palette: Palette, now: number): string {
  const label = lane.label === '' ? '' : `${palette.fg('dim', lane.label)} `
  if (lane.unlimited) return `${label}${palette.fg('dim', 'unlimited')}`
  if (lane.percent === null) return `${label}${palette.fg('dim', '?')}`

  const countdown = formatCountdown(lane.resetAt, now)
  const reset = countdown === null ? '' : ` ${palette.fg('dim', `[⟳ ${countdown}]`)}`
  return `${label}${palette.fg(laneColor(lane.percent), `${Math.round(lane.percent)}%`)}${reset}`
}

/** 东亚全宽字符区间。命中即占 2 列。 */
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

/** 匹配一条 ANSI SGR 序列，形如 `\x1b[32m`、`\x1b[1;32m`、`\x1b[0m`。 */
const SGR_PATTERN = /^\x1b\[[0-9;]*m/

/**
 * 匹配一条 OSC 8 超链接，形如 `\x1b]8;;URL\x1b\\`（结束序列的 URL 为空）。
 *
 * OSC 8 **不是**零宽 SGR：不单独识别它的话，URL 的每个字符都会被算成可见列，
 * 让 footer 的宽度限制彻底失真。
 */
const OSC8_PATTERN = /^\x1b\]8;;([^\x1b\x07]*)(?:\x1b\\|\x07)/

const LINK_CLOSE = '\x1b]8;;\x1b\\'

type EscapeKind = 'open' | 'reset' | 'link-open' | 'link-close'

interface Escape {
  text: string
  kind: EscapeKind
}

/** `\x1b[0m`、`\x1b[m`、`\x1b[0;0m` 都是重置；其余 SGR 视为打开了某种样式。 */
function isResetSgr(sgr: string): boolean {
  return sgr
    .slice(2, -1)
    .split(';')
    .every((part) => part === '' || part === '0')
}

/** 识别位置 `index` 处的转义序列；不是转义序列时返回 null。 */
function escapeAt(text: string, index: number): Escape | null {
  const slice = text.slice(index)

  const sgr = SGR_PATTERN.exec(slice)
  if (sgr !== null) return { text: sgr[0], kind: isResetSgr(sgr[0]) ? 'reset' : 'open' }

  const osc = OSC8_PATTERN.exec(slice)
  if (osc !== null) return { text: osc[0], kind: (osc[1] ?? '') === '' ? 'link-close' : 'link-open' }

  return null
}

/**
 * 终端可见宽度。**不能用 `String.length`** —— 中文字符占 2 列，
 * 组合字符占 0 列，ANSI 颜色与 OSC 8 链接占 0 列。任何一项算错
 * 都会让 footer 的宽度限制失效。
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
 * 按可见宽度截断，绝不切出半个全宽字符，也不切断转义序列。
 *
 * 截断处若颜色或超链接仍然开着，必须显式闭合：Pi 会把所有扩展的 status
 * 用空格拼成同一行，未闭合的颜色会泄漏到后面其他扩展的文字上。
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
 * 重置倒计时，紧凑格式（`42m` / `3h12m` / `2d3h`）。
 *
 * 已过期或没有重置时间时返回 `null`，让调用方整体省略这段，
 * 而不是显示一个会让人误以为「刚重置过」的 `0`。
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
    return `实付 ${formatAmount(actual, unit)}（原价 ${formatAmount(original, unit)}）`
  }
  if (actual !== null) return `实付 ${formatAmount(actual, unit)}`
  if (original !== null) return `原价 ${formatAmount(original, unit)}`
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

    // 钱包是后付费，烧钱速度最关键，所以带 Today；上限型形态的主信息是窗口百分比，
    // 且它们不共用「余额」这个概念，所以不带 Today（明细里仍然有）。
    const todayCost = usage.today?.actualCost ?? null
    if (todayCost !== null) {
      segments.push(palette.fg('dim', `Today ${formatAmount(todayCost, usage.unit, COST_DIGITS)}`))
    }
  } else {
    for (const lane of usage.lanes) segments.push(renderLane(lane, palette, now))
  }

  if (segments.length === 0) return palette.fg('error', `${FOOTER_PREFIX} ?`)

  const label = palette.fg('dim', FOOTER_PREFIX)
  return truncateToWidth(`${label} ${stale ? '~' : ''}${segments.join(' · ')}`, FOOTER_MAX_WIDTH)
}

export function formatDetail(usage: NormalizedUsage, site: SiteCredential): string {
  const balance = (value: number | null): string => formatAmount(value, usage.unit, BALANCE_DIGITS)
  const amount = (value: number | null): string => formatAmount(value, usage.unit, COST_DIGITS)
  const lines: string[] = []

  lines.push(`sub2api · ${site.provider}`)
  lines.push(site.baseUrl)

  const primary = `${usage.primary.label} ${balance(usage.primary.value)}`
  lines.push(usage.primary.detail === undefined ? primary : `${primary}  ${usage.primary.detail}`)

  const today = usageLine('今日', usage.today, usage.unit)
  if (today !== null) lines.push(today)

  const total = usageLine('累计', usage.total, usage.unit)
  if (total !== null) lines.push(total)

  if (usage.daily.length > 0) {
    const recent = usage.daily.slice(-3)
    const cells = recent.map((day) => `${day.date.slice(5)} ${amount(day.actualCost)}`)
    lines.push(`近${recent.length}日 ${cells.join(' · ')}`)
  }

  if (usage.byModel.length > 0) {
    const groups = usage.byModel.slice(0, 3).map((entry) => {
      const cells = `${amount(entry.actualCost)} · ${formatTokens(entry.totalTokens)} tok · ${entry.requests ?? 0} req`
      return `${entry.model} ${cells}`
    })
    lines.push(`按模型 ${groups.join(' · ')}`)
  }

  return lines.filter((line) => line !== '').join('\n')
}
