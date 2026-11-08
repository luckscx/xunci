import type { Identity, Notice, RoomState } from './api'

export type Conn = {
  send: (msg: Record<string, unknown>) => void
  close: () => void
}

type Handlers = {
  onState: (s: RoomState) => void
  onNotice: (n: Notice) => void
  onClose?: () => void
}

/**
 * 连接 /ws，自动重连；每次连上都会带身份重新 hello。
 * 身份通过 getIdentity() 动态获取，改名后重连也会用新名字。
 */
export function connect(getIdentity: () => Identity, handlers: Handlers): Conn {
  let ws: WebSocket | null = null
  let closed = false
  let delay = 500
  let pending = 0

  function open() {
    if (closed) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.onopen = () => {
      delay = 500
      ws?.send(JSON.stringify({ type: 'hello', ...getIdentity() }))
    }
    ws.onmessage = (ev) => {
      let msg: unknown
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      const m = msg as { type?: string }
      if (m.type === 'state') handlers.onState(msg as RoomState)
      else if (m.type === 'notice') handlers.onNotice(msg as Notice)
    }
    ws.onclose = () => {
      handlers.onClose?.()
      if (closed) return
      window.setTimeout(open, delay)
      delay = Math.min(5000, delay * 1.6)
    }
    ws.onerror = () => ws?.close()
  }

  // 延迟到下一个宏任务再真正建连：StrictMode 下"挂载→立刻卸载"时
  // 只会取消定时器，不会留下一个还没握手就被 close 的 socket（否则控制台会报错）
  pending = window.setTimeout(open, 0)

  return {
    send: (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    },
    close: () => {
      closed = true
      window.clearTimeout(pending)
      ws?.close()
    },
  }
}
