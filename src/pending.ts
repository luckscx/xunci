import { useCallback, useEffect, useRef, useState } from 'react'

/** 发出去多久还没回音，就出转圈——快到无感的请求不该闪一下 */
export const SLOW_MS = 300
/** 猜词：本地语义计算，正常几十毫秒；3 秒还没回就是真的不对劲 */
export const TIMEOUT_GUESS = 3000
/** 问一问：判官走大模型，冷启动 + 长问题 3 秒不够用，给到 8 秒 */
export const TIMEOUT_ASK = 8000
/** 兼容旧引用 */
export const TIMEOUT_MS = TIMEOUT_GUESS

type Opts = {
  slowMs?: number
  timeoutMs?: number
  /** 超时回调：参数是本次实际用的超时毫秒数，用来拼提示文案 */
  onTimeout?: (ms: number) => void
}

/**
 * 一次「等结果」的生命周期：
 *   start()  → 0–300ms 静默等待（多数请求在这段就回来了）
 *            → 300ms 起 slow = true，UI 出菊花并锁住操作
 *            → 到点还没回 → 自动 onTimeout(ms)，不留下死锁
 *   stop()   → 结果到了，立刻收菊花
 *
 * start({ timeoutMs }) 可以按玩法覆盖超时：猜词 3 秒、问一问 8 秒。
 * 时间戳不累加，全用 setTimeout，组件卸载时清干净。
 */
export function usePending({ slowMs = SLOW_MS, timeoutMs = TIMEOUT_GUESS, onTimeout }: Opts = {}) {
  const [pending, setPending] = useState(false)
  const [slow, setSlow] = useState(false)
  const slowTimer = useRef(0)
  const outTimer = useRef(0)
  const cb = useRef(onTimeout)
  cb.current = onTimeout

  const clear = useCallback(() => {
    window.clearTimeout(slowTimer.current)
    window.clearTimeout(outTimer.current)
    slowTimer.current = 0
    outTimer.current = 0
  }, [])

  const stop = useCallback(() => {
    clear()
    setPending(false)
    setSlow(false)
  }, [clear])

  const start = useCallback(
    (override?: { timeoutMs?: number }) => {
      const limit = override?.timeoutMs ?? timeoutMs
      clear()
      setPending(true)
      setSlow(false)
      slowTimer.current = window.setTimeout(() => setSlow(true), slowMs)
      outTimer.current = window.setTimeout(() => {
        setPending(false)
        setSlow(false)
        cb.current?.(limit)
      }, limit)
    },
    [clear, slowMs, timeoutMs],
  )

  useEffect(() => clear, [clear])

  return { pending, slow, start, stop }
}
