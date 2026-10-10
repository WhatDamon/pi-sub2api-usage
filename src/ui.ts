import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { FOOTER_STATUS_KEY } from './format.ts'

/**
 * 唯一的 footer 写入点。非 TUI 模式下整体降级为空操作，
 * 且任何 UI 异常都不得向上传播——UI 失败不应影响刷新流程。
 */
export function setFooter(ctx: ExtensionContext, text: string | undefined): void {
  try {
    if (ctx.mode !== 'tui') return
    // 空字符串表示「本次没有可显示的内容」，等价于移除状态键。
    // 传空串而非 undefined 会让部分 footer 合成器渲染出一行空白。
    ctx.ui.setStatus(FOOTER_STATUS_KEY, text === '' ? undefined : text)
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
