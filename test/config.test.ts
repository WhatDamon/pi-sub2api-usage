import { describe, expect, it } from 'vitest'
import {
  keyFingerprint,
  listCandidateSites,
  normalizeUsageUrl,
  resolveCurrentSite,
  type CredentialSource,
} from '../src/config.ts'

const source = (
  model: CredentialSource['model'],
  keys: Record<string, string>,
  all: Array<{ provider: string; baseUrl: string }>,
): CredentialSource => ({
  model,
  modelRegistry: {
    getApiKeyForProvider: async (p: string) => keys[p],
    getAll: () => all,
  },
})

describe('normalizeUsageUrl', () => {
  const want = 'https://gw.example.com/v1/usage'
  it.each([
    ['https://gw.example.com', want],
    ['https://gw.example.com/', want],
    ['https://gw.example.com/v1', want],
    ['https://gw.example.com/v1/', want],
    ['https://gw.example.com/v1/v1', want],
    ['  https://gw.example.com/v1  ', want],
  ])('%s → %s', (input, expected) => {
    expect(normalizeUsageUrl(input)).toBe(expected)
  })
})

describe('keyFingerprint', () => {
  it('is the first 8 hex characters of the sha256 and never leaks the original', () => {
    const fp = keyFingerprint('sk-abcdef123456')
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
    expect(fp).not.toContain('sk-')
    expect(keyFingerprint('sk-abcdef123456')).toBe(fp)
    expect(keyFingerprint('sk-other')).not.toBe(fp)
  })
})

describe('resolveCurrentSite', () => {
  it('resolves usageUrl and fingerprint', async () => {
    const site = await resolveCurrentSite(
      source({ provider: 'site-a', baseUrl: 'https://gw.example.com' }, { 'site-a': 'sk-abcdef123456' }, []),
    )
    expect(site).toEqual({
      provider: 'site-a',
      baseUrl: 'https://gw.example.com',
      usageUrl: 'https://gw.example.com/v1/usage',
      apiKey: 'sk-abcdef123456',
      fingerprint: keyFingerprint('sk-abcdef123456'),
    })
  })

  it('returns undefined when there is no current model', async () => {
    expect(await resolveCurrentSite(source(undefined, {}, []))).toBeUndefined()
  })

  it('returns undefined when no key can be resolved', async () => {
    const src = source({ provider: 'site-a', baseUrl: 'https://gw.example.com' }, {}, [])
    expect(await resolveCurrentSite(src)).toBeUndefined()
  })

  it('returns undefined instead of throwing when modelRegistry throws', async () => {
    const src: CredentialSource = {
      model: { provider: 'site-a', baseUrl: 'https://gw.example.com' },
      modelRegistry: {
        getApiKeyForProvider: async () => { throw new Error('boom') },
        getAll: () => [],
      },
    }
    expect(await resolveCurrentSite(src)).toBeUndefined()
  })
})

describe('listCandidateSites', () => {
  it('deduplicates by provider, skips providers with no resolvable key, and keeps first-seen order', async () => {
    const sites = await listCandidateSites(
      source(
        undefined,
        { a: 'sk-a', c: 'sk-c' },
        [
          { provider: 'a', baseUrl: 'https://h1' },
          { provider: 'a', baseUrl: 'https://h1' },
          { provider: 'b', baseUrl: 'https://h2' },
          { provider: 'c', baseUrl: 'https://h3/v1' },
        ],
      ),
    )
    expect(sites.map((s) => s.provider)).toEqual(['a', 'c'])
    expect(sites.map((s) => s.usageUrl)).toEqual(['https://h1/v1/usage', 'https://h3/v1/usage'])
  })
})
