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
 * Normalises a sub2api usage endpoint.
 *
 * A configured baseUrl may carry a trailing slash, may already include `/v1`, or may
 * have both. So: strip every trailing `/`, drop a trailing (possibly repeated) `/v1`
 * segment, then append `/v1/usage`.
 */
export function normalizeUsageUrl(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, '').replace(/(?:\/v1)+$/, '')
  return `${root}/v1/usage`
}

/** The first 8 hex characters of the apiKey's sha256. Used only for logging and deduplication; not reversible. */
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

/** Resolves the site for the provider the current model belongs to. Any failure degrades to undefined; never throws. */
export async function resolveCurrentSite(source: CredentialSource): Promise<SiteCredential | undefined> {
  try {
    const model = source.model
    if (!model) return undefined
    return await buildSite(model.provider, model.baseUrl, source)
  } catch {
    return undefined
  }
}

/** Lists every site with resolvable credentials in Pi's config, deduplicated by provider and keeping first-seen order. */
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
