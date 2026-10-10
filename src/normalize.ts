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
 * 一个可显示的上限窗口（配额 / 订阅周期 / 速率窗口），供 footer 一行渲染。
 * `percent` 是**原始**已用百分比，取整与阀值着色留给渲染层。
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

const SUBSCRIPTION_WINDOWS = [
  { key: 'daily', detail: '日', lane: '1d' },
  { key: 'weekly', detail: '周', lane: '7d' },
  { key: 'monthly', detail: '月', lane: '1m' },
] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 读取数值。**缺失返回 null，绝不返回 0** —— `0` 与「未知」是两种不同的语义，
 * 混用会让「今天没消耗」和「后端没给这个字段」在界面上变得无法区分。
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

/** `reset_at` 是 ISO 字符串；解析失败返回 null，绝不让 NaN 流进渲染层。 */
function parseResetAt(value: string | null): number | null {
  if (value === null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 订阅形态：一次遍历同时产出三个东西——主数值（三窗口剩余的最小值）、
 * 中文明细（给 `/sub2-usage`）与英文窗口（给 footer）。
 *
 * 两者标签不同（`日` vs `1d`），所以不能从 lanes 反推明细；同一次遍历产出
 * 可以避免百分比算两遍，同时保证现有明细字符串逐字不变。
 *
 * `limit` 为负数表示该窗口不限额（后端用 -1 作为哨兵值），不参与最小值计算。
 */
function subscriptionParts(subscription: Record<string, unknown>): {
  value: number | null
  detail: string
  lanes: UsageLane[]
} {
  const parts: string[] = []
  const lanes: UsageLane[] = []
  let min: number | null = null

  for (const { key, detail, lane } of SUBSCRIPTION_WINDOWS) {
    const limit = num(subscription[`${key}_limit_usd`])
    const used = num(subscription[`${key}_usage_usd`]) ?? 0

    if (limit === null || limit < 0) {
      parts.push(`${detail} 无限`)
      lanes.push({ label: lane, percent: null, resetAt: null, unlimited: true })
      continue
    }

    const percent = limit > 0 ? (used / limit) * 100 : 0
    parts.push(`${detail} ${Math.round(percent)}%`)
    lanes.push({ label: lane, percent, resetAt: null, unlimited: false })

    const remaining = limit - used
    if (min === null || remaining < min) min = remaining
  }

  return { value: min, detail: parts.join(' · '), lanes }
}

/**
 * 四种计费形态归一化为统一结构。形态互斥，判定顺序固定：
 * quota → rate_limit → subscription → wallet。
 *
 * `rateLimits` 只要存在就填充，即使主形态是 quota —— 一个 Key 可以同时
 * 有配额上限和速率上限，两种信息对用户都有用。
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
      label: '配额剩余',
      value: quota ? num(quota.remaining) : null,
      detail: `已用 ${show(quotaUsed)} / ${show(quotaLimit)}`,
    }
    // 配额本身没有重置时间戳（只有 expires_at），因此不带倒计时。
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
      label: `${peak.window} 窗口剩余`,
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
    primary = { label: '订阅剩余', value: summary.value, detail: summary.detail }
    lanes = summary.lanes
  } else {
    mode = 'wallet'
    primary = {
      label: '钱包余额（多 Key 共享）',
      value: num(record.remaining) ?? num(record.balance),
      detail: undefined,
    }
    lanes = []
  }

  const usage = asRecord(record.usage)

  return {
    mode,
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
