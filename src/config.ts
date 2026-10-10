import { createHash } from 'node:crypto'

export interface SiteCredential {
  provider: string
  baseUrl: string
  usageUrl: string
  apiKey: string
  fingerprint: string
}

export interface CredentialSource {
  model: { provider: string; baseUrl: string } | undefined
  modelRegistry: {
    getApiKeyForProvider(provider: string): Promise<string | undefined>
    getAll(): ReadonlyArray<{ provider: string; baseUrl: string }>
  }
}

/**
 * 归一化为 sub2api 的用量端点。
 *
 * 用户配置里的 baseUrl 可能带尾斜杠、可能已含 `/v1`、也可能两者都有，
 * 因此先去掉尾部所有 `/`，再去掉尾部重复的 `/v1` 段，最后拼上 `/v1/usage`。
 */
export function normalizeUsageUrl(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, '').replace(/(?:\/v1)+$/, '')
  return `${root}/v1/usage`
}

/** apiKey 的 sha256 前 8 位。仅用于日志与去重，不可逆。 */
export function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 8)
}

async function buildSite(
  provider: string,
  baseUrl: string | undefined,
  source: CredentialSource,
): Promise<SiteCredential | undefined> {
  const base = (baseUrl ?? '').trim()
  if (base === '') return undefined

  const apiKey = (await source.modelRegistry.getApiKeyForProvider(provider)) ?? ''
  if (apiKey === '') return undefined

  return {
    provider,
    baseUrl: base,
    usageUrl: normalizeUsageUrl(base),
    apiKey,
    fingerprint: keyFingerprint(apiKey),
  }
}

/** 解析当前模型所属 provider 对应的站点。任何失败都退化为 undefined，不抛出。 */
export async function resolveCurrentSite(source: CredentialSource): Promise<SiteCredential | undefined> {
  try {
    const model = source.model
    if (!model) return undefined
    return await buildSite(model.provider, model.baseUrl, source)
  } catch {
    return undefined
  }
}

/** 列出 Pi 配置中所有可解析凭证的站点，按 provider 去重并保持首次出现顺序。 */
export async function listCandidateSites(source: CredentialSource): Promise<SiteCredential[]> {
  try {
    const seen = new Set<string>()
    const sites: SiteCredential[] = []
    for (const model of source.modelRegistry.getAll()) {
      if (seen.has(model.provider)) continue
      seen.add(model.provider)
      const site = await buildSite(model.provider, model.baseUrl, source)
      if (site) sites.push(site)
    }
    return sites
  } catch {
    return []
  }
}
