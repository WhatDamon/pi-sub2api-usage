export type UsageMode = 'wallet' | 'subscription' | 'quota' | 'rate_limit'

export interface UsageBucket {
  requests: number | null
  totalTokens: number | null
  cost: number | null
  actualCost: number | null
}

export interface DailyBucket {
  date: string
  requests: number | null
  actualCost: number | null
}

export interface ModelBucket {
  model: string
  requests: number | null
  totalTokens: number | null
  actualCost: number | null
}

export interface RateLimitWindow {
  window: string
  limit: number
  used: number
  remaining: number
  usedRatio: number
  resetAt: string | null
}

/**
 * A renderable upper-limit window (quota / subscription period / rate window),
 * shown as one segment of the footer.
 *
 * `percent` is the **raw** used percentage; rounding and threshold colouring are
 * the renderer's job.
 */
export interface UsageLane {
  label: string
  percent: number | null
  resetAt: number | null
  unlimited: boolean
}

export interface NormalizedUsage {
  mode: UsageMode
  planName: string
  unit: string
  sharedBalance: boolean
  primary: { label: string; value: number | null; detail: string | undefined }
  today: UsageBucket | null
  total: UsageBucket | null
  daily: DailyBucket[]
  byModel: ModelBucket[]
  rateLimits: RateLimitWindow[]
  lanes: UsageLane[]
  isValid: boolean
  fetchedAt: number
}

export class UnrecognizedUsageError extends Error {
  constructor(message = 'unrecognized sub2api usage payload') {
    super(message)
    this.name = 'UnrecognizedUsageError'
  }
}

const SUB2API_WIRE_MODES = ['quota_limited', 'unrestricted'] as const

/**
 * The three subscription windows, in display order.
 *
 * `label` serves both the detail line and the footer lane. These used to be two
 * separate fields only because the detail was Chinese ('日') while the footer was
 * English ('1d'); with both in English they are the same string.
 */
const SUBSCRIPTION_WINDOWS = [
  { key: 'daily', label: '1d' },
  { key: 'weekly', label: '7d' },
  { key: 'monthly', label: '1m' },
] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Read a number. **A missing value returns null, never 0** — `0` and "unknown"
 * are two different meanings, and conflating them makes "spent nothing today"
 * and "the backend did not send this field" indistinguishable in the UI.
 */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function show(value: number | null): string {
  return value === null ? '—' : String(value)
}

function bucket(record: Record<string, unknown> | undefined): UsageBucket | null {
  if (!record) return null
  return {
    requests: num(record.requests),
    totalTokens: num(record.total_tokens),
    cost: num(record.cost),
    actualCost: num(record.actual_cost),
  }
}

function parseDaily(value: unknown): DailyBucket[] {
  if (!Array.isArray(value)) return []
  const out: DailyBucket[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) continue
    const date = str(record.date)
    if (date === null) continue
    out.push({ date, requests: num(record.requests), actualCost: num(record.actual_cost) })
  }
  return out
}

function parseByModel(value: unknown): ModelBucket[] {
  if (!Array.isArray(value)) return []
  const out: ModelBucket[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) continue
    const model = str(record.model)
    if (model === null) continue
    out.push({
      model,
      requests: num(record.requests),
      totalTokens: num(record.total_tokens),
      actualCost: num(record.actual_cost),
    })
  }
  out.sort((a, b) => {
    const left = a.actualCost ?? Number.NEGATIVE_INFINITY
    const right = b.actualCost ?? Number.NEGATIVE_INFINITY
    if (left === right) return 0
    return right - left
  })
  return out
}

function parseRateLimits(value: unknown): RateLimitWindow[] {
  if (!Array.isArray(value)) return []
  const out: RateLimitWindow[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) continue
    const window = str(record.window)
    if (window === null) continue
    const limit = num(record.limit) ?? 0
    const used = num(record.used) ?? 0
    out.push({
      window,
      limit,
      used,
      remaining: num(record.remaining) ?? 0,
      usedRatio: limit > 0 ? used / limit : 0,
      resetAt: str(record.reset_at),
    })
  }
  return out
}

/** `reset_at` is an ISO string; a parse failure returns null so NaN never reaches the renderer. */
function parseResetAt(value: string | null): number | null {
  if (value === null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Subscription mode: one pass produces three things at once — the primary value
 * (the smallest remaining amount across the three windows), the detail string for
 * `/sub2-usage`, and the footer lanes.
 *
 * Producing them together keeps the percentages from being computed twice and
 * guarantees the detail and the lanes can never disagree.
 *
 * A negative `limit` means the window is uncapped (the backend uses -1 as a
 * sentinel value); such a window never participates in the minimum.
 */
function subscriptionParts(subscription: Record<string, unknown>): {
  value: number | null
  detail: string
  lanes: UsageLane[]
} {
  const parts: string[] = []
  const lanes: UsageLane[] = []
  let min: number | null = null

  for (const { key, label } of SUBSCRIPTION_WINDOWS) {
    const limit = num(subscription[`${key}_limit_usd`])
    const used = num(subscription[`${key}_usage_usd`]) ?? 0

    if (limit === null || limit < 0) {
      parts.push(`${label} unlimited`)
      lanes.push({ label, percent: null, resetAt: null, unlimited: true })
      continue
    }

    const percent = limit > 0 ? (used / limit) * 100 : 0
    parts.push(`${label} ${Math.round(percent)}%`)
    lanes.push({ label, percent, resetAt: null, unlimited: false })

    const remaining = limit - used
    if (min === null || remaining < min) min = remaining
  }

  return { value: min, detail: parts.join(' · '), lanes }
}

/**
 * Normalise the four billing modes into one shape. The modes are mutually
 * exclusive and the detection order is fixed:
 * quota → rate_limit → subscription → wallet.
 *
 * `rateLimits` is filled in whenever present, even when the primary mode is
 * quota — a single key can carry both a quota cap and a rate cap, and both are
 * useful to the user.
 */
export function normalize(body: unknown, now?: number): NormalizedUsage {
  const record = asRecord(body)
  if (!record) throw new UnrecognizedUsageError()

  const wireMode = record.mode
  if (wireMode !== SUB2API_WIRE_MODES[0] && wireMode !== SUB2API_WIRE_MODES[1]) {
    throw new UnrecognizedUsageError()
  }

  const quota = asRecord(record.quota)
  const quotaLimit = quota ? num(quota.limit) : null
  const rateLimits = parseRateLimits(record.rate_limits)
  const subscription = asRecord(record.subscription)

  let mode: UsageMode
  let primary: NormalizedUsage['primary']
  let lanes: UsageLane[]

  if (quotaLimit !== null && quotaLimit > 0) {
    mode = 'quota'
    const quotaUsed = quota ? num(quota.used) : null
    primary = {
      label: 'Quota left',
      value: quota ? num(quota.remaining) : null,
      detail: `used ${show(quotaUsed)} / ${show(quotaLimit)}`,
    }
    // Quota itself carries no reset timestamp (only `expires_at`), so no countdown.
    lanes = [
      {
        label: '',
        percent: quotaUsed === null ? null : (quotaUsed / quotaLimit) * 100,
        resetAt: null,
        unlimited: false,
      },
    ]
  } else if (rateLimits.length > 0) {
    mode = 'rate_limit'
    const peak = rateLimits.reduce((best, current) => (current.usedRatio > best.usedRatio ? current : best))
    primary = {
      label: `${peak.window} window left`,
      value: peak.remaining,
      detail: rateLimits.map((w) => `${w.window} ${Math.round(w.usedRatio * 100)}%`).join(' · '),
    }
    lanes = rateLimits.map((window) => ({
      label: window.window,
      percent: window.usedRatio * 100,
      resetAt: parseResetAt(window.resetAt),
      unlimited: false,
    }))
  } else if (subscription && Object.keys(subscription).length > 0) {
    mode = 'subscription'
    const summary = subscriptionParts(subscription)
    primary = { label: 'Subscription left', value: summary.value, detail: summary.detail }
    lanes = summary.lanes
  } else {
    mode = 'wallet'
    primary = {
      label: 'Wallet balance (shared across keys)',
      value: num(record.remaining) ?? num(record.balance),
      detail: undefined,
    }
    lanes = []
  }

  const usage = asRecord(record.usage)

  return {
    mode,
    // `planName` is a backend-supplied label that we only pass through, never
    // render ourselves. sub2api returns Chinese names ("钱包余额" for wallet
    // mode), so the fallback deliberately mirrors the backend's own vocabulary.
    planName: str(record.planName) ?? '钱包余额',
    unit: str(record.unit) ?? 'USD',
    sharedBalance: mode === 'wallet',
    primary,
    today: bucket(asRecord(usage?.today)),
    total: bucket(asRecord(usage?.total)),
    daily: parseDaily(record.daily_usage),
    byModel: parseByModel(record.model_stats),
    rateLimits,
    lanes,
    isValid: record.isValid !== false,
    fetchedAt: now ?? Date.now(),
  }
}
