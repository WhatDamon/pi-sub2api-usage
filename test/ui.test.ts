import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { FOOTER_STATUS_KEY } from '../src/format.ts'
import { setFooter } from '../src/ui.ts'

interface StatusCall {
  key: string
  text: string | undefined
}

function fakeCtx(options: { hasUI: boolean; mode: string }): { ctx: ExtensionContext; calls: StatusCall[] } {
  const calls: StatusCall[] = []
  const ctx = {
    hasUI: options.hasUI,
    mode: options.mode,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        calls.push({ key, text })
      },
    },
  } as unknown as ExtensionContext
  return { ctx, calls }
}

describe('setFooter', () => {
  it('writes the status whenever a UI exists, including RPC mode where Pi supports setStatus', () => {
    // Pi documents setStatus as a fire-and-forget RPC method and reports hasUI=true
    // in RPC mode, so guarding on mode === 'tui' would silence the footer there.
    const { ctx, calls } = fakeCtx({ hasUI: true, mode: 'rpc' })
    setFooter(ctx, 'Sub2 $1.88')
    expect(calls).toEqual([{ key: FOOTER_STATUS_KEY, text: 'Sub2 $1.88' }])
  })

  it('stays a no-op in a mode that has no UI at all', () => {
    const { ctx, calls } = fakeCtx({ hasUI: false, mode: 'print' })
    setFooter(ctx, 'Sub2 $1.88')
    expect(calls).toEqual([])
  })

  it('clears the status key for an empty string', () => {
    const { ctx, calls } = fakeCtx({ hasUI: true, mode: 'tui' })
    setFooter(ctx, '')
    expect(calls).toEqual([{ key: FOOTER_STATUS_KEY, text: undefined }])
  })

  it('clears the status key for undefined', () => {
    const { ctx, calls } = fakeCtx({ hasUI: true, mode: 'tui' })
    setFooter(ctx, undefined)
    expect(calls).toEqual([{ key: FOOTER_STATUS_KEY, text: undefined }])
  })

  it('keeps the status text plain outside TUI mode even when a link is given', () => {
    // RPC transports status text as a plain string field and Pi reports no theme or
    // capability support there, so no escape sequence may travel over that channel.
    const { ctx, calls } = fakeCtx({ hasUI: true, mode: 'rpc' })
    setFooter(ctx, 'Sub2 $1.88', 'https://gw.example.com')
    expect(calls[0]?.text).toBe('Sub2 $1.88')
  })

  it('never lets a UI exception escape', () => {
    const ctx = {
      hasUI: true,
      mode: 'tui',
      ui: {
        setStatus: () => {
          throw new Error('terminal went away')
        },
      },
    } as unknown as ExtensionContext
    expect(() => setFooter(ctx, 'Sub2 $1.88')).not.toThrow()
  })
})
