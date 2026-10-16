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

/** One rate-limit window. Every numeric field is nullable: the backend may omit any of them. */
interface RateLimitWindow {
  window: string
  limit: number | null
  used: number | null
  remaining: number | null
  usedRatio: number | null
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
  unit: string
  primary: {
    label: string
    value: number | null
    detail: string | undefined
    /**
     * How `value` must be rendered. Not every primary value is money: in rate-limit
     * mode it counts requests, and formatting a count as currency turns "18 requests
     * left" into `$18.00`.
     */
    format: 'amount' | 'count'
  }
  today: UsageBucket | null
  total: UsageBucket | null
  daily: DailyBucket[]
  byModel: ModelBucket[]
  lanes: UsageLane[]
  fetchedAt: number
}

export class UnrecognizedUsageError extends Error {
  constructor(message = 'unrecognized sub2api usage payload') {
    super(message)
    this.name = 'UnrecognizedUsageError'
  }
}

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
 * The only two top-level `mode` values sub2api ever sends, and the single place the
 * whitelist is applied. The probe calls `isSub2ApiPayload` below rather than keeping its
 * own copy, so the two can never disagree about what a sub2api payload is.
 */
const SUB2API_WIRE_MODES = ['quota_limited', 'unrestricted'] as const

function isSub2ApiWireMode(mode: unknown): boolean {
  return typeof mode === 'string' && SUB2API_WIRE_MODES.some((known) => known === mode)
}

/**
 * Whether a response body came from sub2api.
 *
 * The only criterion is the top-level `mode` field: no guessing from the hostname and no
 * reliance on the status code, because a non-sub2api gateway happily returns 200 with valid
 * JSON. "Has a whitelisted mode field" is what separates the two.
 *
 * The probe checks this before handing a body over, which is what makes `kind === 'ok'`
 * imply "`normalize()` will not reject this as unrecognized" — the invariant that lets the
 * probe's callers skip a guard around `normalize()`.
 */
export function isSub2ApiPayload(body: unknown): boolean {
  return isSub2ApiWireMode(asRecord(body)?.mode)
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
    const limit = num(record.limit)
    const used = num(record.used)
    out.push({
      window,
      limit,
      used,
      remaining: num(record.remaining),
      // A ratio needs both numbers. Without them the window's usage is simply unknown,
      // and reporting 0% would read as "nothing used yet".
      usedRatio: limit !== null && used !== null && limit > 0 ? used / limit : null,
      resetAt: str(record.reset_at),
    })
  }
  return out
}

/** Renders a used ratio for the detail line; an unknown ratio must not become 0%. */
function percentText(ratio: number | null): string {
  return ratio === null ? '?' : `${Math.round(ratio * 100)}%`
}

/**
 * The window closest to its cap, which names what the primary value refers to.
 * A window with an unknown ratio can never win, so a known one is always preferred.
 */
function peakWindow(windows: readonly RateLimitWindow[]): RateLimitWindow | undefined {
  let best: RateLimitWindow | undefined
  for (const window of windows) {
    if (window.usedRatio === null) continue
    if (best === undefined || best.usedRatio === null || window.usedRatio > best.usedRatio) {
      best = window
    }
  }
  return best
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
    const used = num(subscription[`${key}_usage_usd`])

    // Only an explicit negative limit means "uncapped". A missing limit is unknown, and
    // reporting it as unlimited would promise something the backend never said.
    if (limit !== null && limit < 0) {
      parts.push(`${label} unlimited`)
      lanes.push({ label, percent: null, resetAt: null, unlimited: true })
      continue
    }

    // A known limit with unknown consumption is unknown, not "0% used". It also cannot
    // contribute a remaining amount: `limit - 0` would overstate what is left.
    if (limit === null || used === null) {
      parts.push(`${label} ?`)
      lanes.push({ label, percent: null, resetAt: null, unlimited: false })
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

  // The same whitelist the probe checks, so any body reaching normalize() through the probe
  // is already known to be sub2api's. This stays as the module's precondition for callers
  // that use it on its own.
  if (!isSub2ApiWireMode(record.mode)) throw new UnrecognizedUsageError()

  const quota = asRecord(record.quota)
  const quotaLimit = quota ? num(quota.limit) : null
  const rateLimits = parseRateLimits(record.rate_limits)
  const subscription = asRecord(record.subscription)

  let mode: UsageMode
  let primary: NormalizedUsage['primary']
  let lanes: UsageLane[]

  // Reading the first window here, rather than testing `rateLimits.length > 0`, is what
  // lets the rate-limit branch use a window without a non-null assertion.
  const firstRateWindow = rateLimits[0]

  if (quotaLimit !== null && quotaLimit > 0) {
    mode = 'quota'
    const quotaUsed = quota ? num(quota.used) : null
    primary = {
      label: 'Quota left',
      value: quota ? num(quota.remaining) : null,
      format: 'amount',
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
  } else if (firstRateWindow !== undefined) {
    mode = 'rate_limit'
    const peak = peakWindow(rateLimits) ?? firstRateWindow
    primary = {
      label: `${peak.window} window left`,
      // `limit`/`used`/`remaining` count requests here, not money.
      value: peak.remaining,
      format: 'count',
      detail: rateLimits.map((w) => `${w.window} ${percentText(w.usedRatio)}`).join(' · '),
    }
    lanes = rateLimits.map((window) => ({
      label: window.window,
      percent: window.usedRatio === null ? null : window.usedRatio * 100,
      resetAt: parseResetAt(window.resetAt),
      unlimited: false,
    }))
  } else if (subscription && Object.keys(subscription).length > 0) {
    mode = 'subscription'
    const summary = subscriptionParts(subscription)
    primary = {
      label: 'Subscription left',
      value: summary.value,
      format: 'amount',
      detail: summary.detail,
    }
    lanes = summary.lanes
  } else {
    mode = 'wallet'
    primary = {
      label: 'Wallet balance (shared across keys)',
      value: num(record.remaining) ?? num(record.balance),
      format: 'amount',
      detail: undefined,
    }
    lanes = []
  }

  const usage = asRecord(record.usage)

  return {
    mode,
    unit: str(record.unit) ?? 'USD',
    primary,
    today: bucket(asRecord(usage?.today)),
    total: bucket(asRecord(usage?.total)),
    daily: parseDaily(record.daily_usage),
    byModel: parseByModel(record.model_stats),
    lanes,
    fetchedAt: now ?? Date.now(),
  }
}
