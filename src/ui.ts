import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getCapabilities, hyperlink } from '@earendil-works/pi-tui'
import { FOOTER_STATUS_KEY } from './format.ts'

/**
 * 终端支持超链接时才包 OSC 8，否则原样返回纯文本。
 *
 * 链接在**截断之后**才套上：`formatFooter` 已经按可见宽度裁剪到 40 列，
 * 这里再包链接不会影响宽度核算。
 */
function formatLink(text: string, url: string): string {
  return getCapabilities().hyperlinks ? hyperlink(text, url) : text
}

/**
 * 唯一的 footer 写入点。非 TUI 模式下整体降级为空操作，
 * 且任何 UI 异常都不得向上传播——UI 失败不应影响刷新流程。
 */
export function setFooter(ctx: ExtensionContext, text: string | undefined, link?: string): void {
  try {
    if (ctx.mode !== 'tui') return

    // 空字符串表示「本次没有可显示的内容」，等价于移除状态键。
    // 传空串而非 undefined 会让部分 footer 合成器渲染出一行空白。
    if (text === undefined || text === '') {
      ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined)
      return
    }

    ctx.ui.setStatus(FOOTER_STATUS_KEY, link === undefined ? text : formatLink(text, link))
  } catch {
    /* UI 不可用不应影响刷新流程 */
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
    /* UI 不可用不应影响刷新流程 */
  }
}
