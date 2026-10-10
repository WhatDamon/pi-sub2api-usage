import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getCapabilities, hyperlink } from '@earendil-works/pi-tui'
import { FOOTER_STATUS_KEY } from './format.ts'

/**
 * Wraps in OSC 8 only when the terminal supports hyperlinks, otherwise returns the
 * plain text unchanged.
 *
 * The link is applied **after** truncation: `formatFooter` has already trimmed to 40
 * visible columns, so wrapping here cannot disturb the width accounting.
 */
function formatLink(text: string, url: string): string {
  return getCapabilities().hyperlinks ? hyperlink(text, url) : text
}

/**
 * The single footer write point. It degrades to a no-op outside TUI mode, and no UI
 * exception may propagate upwards — a UI failure must never affect the refresh flow.
 */
export function setFooter(ctx: ExtensionContext, text: string | undefined, link?: string): void {
  try {
    if (ctx.mode !== 'tui') return

    // An empty string means "nothing to show this time", which is equivalent to
    // removing the status key. Passing '' rather than undefined would make some
    // footer composers render a blank row.
    if (text === undefined || text === '') {
      ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined)
      return
    }

    ctx.ui.setStatus(FOOTER_STATUS_KEY, link === undefined ? text : formatLink(text, link))
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
