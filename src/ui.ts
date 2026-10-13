import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getCapabilities, hyperlink } from '@earendil-works/pi-tui'
import { FOOTER_STATUS_KEY } from './format.ts'

/**
 * Wraps in OSC 8 only when the terminal supports hyperlinks, otherwise returns the
 * plain text unchanged.
 *
 * The link is applied **after** truncation: `formatFooter` has already trimmed to the
 * footer width, so wrapping here cannot disturb the width accounting.
 */
function formatLink(text: string, url: string): string {
  return getCapabilities().hyperlinks ? hyperlink(text, url) : text
}

/**
 * The single footer write point. It degrades to a no-op when there is no UI, and no UI
 * exception may propagate upwards — a UI failure must never affect the refresh flow.
 *
 * The guard is `hasUI`, not `mode === 'tui'`. Pi reports `hasUI === true` in RPC mode
 * as well, and documents `setStatus` as a supported fire-and-forget RPC method, so
 * guarding on TUI would silently drop the footer there. `mode === 'tui'` is meant for
 * methods that need a real terminal, such as `custom()`.
 */
export function setFooter(ctx: ExtensionContext, text: string | undefined, link?: string): void {
  try {
    if (!ctx.hasUI) return

    // An empty string means "nothing to show this time", which is equivalent to
    // removing the status key. Passing '' rather than undefined would make some
    // footer composers render a blank row.
    if (text === undefined || text === '') {
      ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined)
      return
    }

    // Escape sequences stay TUI-only. RPC carries status text as a plain string field
    // in a JSON request, and Pi reports no theme support in RPC mode (`getAllThemes()`
    // returns an empty list), so there is no guarantee that a link or colour would be
    // interpreted rather than shown literally.
    const body = ctx.mode === 'tui' && link !== undefined ? formatLink(text, link) : text
    ctx.ui.setStatus(FOOTER_STATUS_KEY, body)
  } catch {
    /* A UI failure must not affect the refresh flow */
  }
}

export function notify(ctx: ExtensionContext, message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
  try {
    if (ctx.hasUI) {
      ctx.ui.notify(message, type)
      return
    }
    console.log(message)
  } catch {
    /* A UI failure must not affect the refresh flow */
  }
}
