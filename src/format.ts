import type { SiteCredential } from './config.ts'
import type { NormalizedUsage, UsageBucket } from './normalize.ts'

export const FOOTER_MAX_WIDTH = 40
export const FOOTER_STATUS_KEY = 'sub2api-usage'

export type FooterState =
  | { kind: 'ok'; usage: NormalizedUsage; stale: boolean }
  | { kind: 'unauthorized' }
  | { kind: 'error'; usage: NormalizedUsage | null }
  | { kind: 'idle' }

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', CNY: '¥' }

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

/**
 * 终端可见宽度。**不能用 `String.length`** —— 中文字符占 2 列，
 * 组合字符占 0 列，按码元计数会让 footer 的宽度限制彻底失效。
 */
export function visibleWidth(text: string): number {
  let total = 0
  for (const char of text) total += charWidth(char)
  return total
}

/** 按可见宽度截断，绝不切出半个全宽字符。 */
export function truncateToWidth(text: string, max: number): string {
  let total = 0
  let out = ''
  for (const char of text) {
    const width = charWidth(char)
    if (total + width > max) break
    total += width
    out += char
  }
  return out
}

export function formatAmount(value: number | null, unit = 'USD'): string {
  if (value === null) return '—'
  const amount = value.toFixed(4)
  const symbol = CURRENCY_SYMBOLS[unit]
  return symbol === undefined ? `${unit} ${amount}` : `${symbol}${amount}`
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

export function formatFooter(state: FooterState): string {
  if (state.kind === 'idle') return ''
  if (state.kind === 'unauthorized') return 'sub2 !'
  if (state.usage === null) return 'sub2 ?'

  const usage = state.usage
  const stale = state.kind === 'ok' ? state.stale : true

  const segments: string[] = []
  if (usage.primary.value !== null) {
    segments.push(formatAmount(usage.primary.value, usage.unit))
  }

  const todayCost = usage.today?.actualCost ?? null
  if (todayCost !== null) {
    segments.push(`今 ${formatAmount(todayCost, usage.unit)}`)
  }

  if (segments.length === 0) return 'sub2 ?'
  return truncateToWidth(`sub2 ${stale ? '~' : ''}${segments.join(' · ')}`, FOOTER_MAX_WIDTH)
}

export function formatDetail(usage: NormalizedUsage, site: SiteCredential): string {
  const amount = (value: number | null): string => formatAmount(value, usage.unit)
  const lines: string[] = []

  lines.push(`sub2api · ${site.provider}`)
  lines.push(site.baseUrl)

  const primary = `${usage.primary.label} ${amount(usage.primary.value)}`
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
