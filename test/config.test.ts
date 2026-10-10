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
  it('是 sha256 前 8 位十六进制，且不泄漏原文', () => {
    const fp = keyFingerprint('sk-abcdef123456')
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
    expect(fp).not.toContain('sk-')
    expect(keyFingerprint('sk-abcdef123456')).toBe(fp)
    expect(keyFingerprint('sk-other')).not.toBe(fp)
  })
})

describe('resolveCurrentSite', () => {
  it('解析出 usageUrl 与 fingerprint', async () => {
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

  it('没有当前模型时返回 undefined', async () => {
    expect(await resolveCurrentSite(source(undefined, {}, []))).toBeUndefined()
  })

  it('取不到 Key 时返回 undefined', async () => {
    const src = source({ provider: 'site-a', baseUrl: 'https://gw.example.com' }, {}, [])
    expect(await resolveCurrentSite(src)).toBeUndefined()
  })

  it('modelRegistry 抛错时返回 undefined 而不是抛出', async () => {
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
  it('按 provider 去重，跳过取不到 Key 的 provider，保持首次出现顺序', async () => {
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
