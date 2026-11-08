// 验证「300ms 才出菊花 + 按玩法超时解锁」
//   猜词 3000ms / 问一问 8000ms
// 1) 自由玩 · 猜词：吞掉 WS 的 guess 帧 → 菊花 ~300ms 出现、3 秒解锁
// 2) 自由玩 · 问一问：把 state 的 judgeReady 改成 true 并吞掉 ask 帧 → 8 秒解锁
// 3) 自由玩 · 正常猜词：全程不该出菊花（不能闪）
// 4) 闯关 · REST 延迟 450ms → 菊花 ~300ms 出现、响应到达即消失
// 5) 闯关 · REST 挂 5 秒 → ~3 秒 abort、提示超时、输入框重新可用
//
// 用法：node qa/thinking.mjs   （默认 http://127.0.0.1:3110，可用 URL= 覆盖）
import { chromium } from 'playwright'

const B = process.env.URL || 'http://127.0.0.1:3110'
const SLOW = 300
const ms = { guess: 3000, ask: 8000 }

const fails = []
const check = (ok, label, detail) => {
  console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails.push(label)
}
const near = (v, target, tol) => Math.abs(v - target) <= tol

async function pollThinking(p, ms) {
  const t0 = Date.now()
  const seen = []
  let prev = null
  while (Date.now() - t0 < ms) {
    const s = await p.evaluate(() => ({
      thinking: !!document.querySelector('.thinking'),
      label: document.querySelector('.thinking-card')?.textContent?.trim() || '',
      err: document.querySelector('.err')?.textContent?.trim() || '',
      disabled: document.querySelector('.entry input')?.disabled ?? null,
    }))
    const key = `${s.thinking}|${s.err}|${s.disabled}`
    if (key !== prev) {
      seen.push({ t: Date.now() - t0, ...s })
      prev = key
    }
    await p.waitForTimeout(40)
  }
  return seen
}

/** 公共房间全局共享，先开一局干净的，避免上一轮的结算弹层挡住按钮 */
async function resetRoom() {
  const r = await fetch(`${B}/api/game`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!r.ok) throw new Error(`重置对局失败 HTTP ${r.status}`)
  return (await r.json()).id
}

const b = await chromium.launch()

// ---------- 1) 自由玩 · 猜词：服务端不回 → 3 秒 ----------
{
  await resetRoom()
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await c.addInitScript(() => {
    const Native = window.WebSocket
    class Slow extends Native {
      send(data) {
        try {
          const m = JSON.parse(data)
          if (m.type === 'guess' || m.type === 'ask') {
            window.__dropped = (window.__dropped || 0) + 1
            return
          }
        } catch {
          /* 非 JSON 原样发出 */
        }
        super.send(data)
      }
    }
    window.WebSocket = Slow
  })
  const p = await c.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(B, { waitUntil: 'networkidle' })
  await p.waitForTimeout(1200)
  await p.locator('.mode-btn', { hasText: '猜词' }).click()
  await p.waitForTimeout(200)
  await p.fill('.entry input', '汽车')
  await p.click('.entry button')
  const seen = await pollThinking(p, 4200)
  await p.screenshot({ path: '/tmp/xunci-thinking-guess.png' })
  console.log('\n[1] 自由玩 · 猜词 · 服务端不回：')
  for (const s of seen)
    console.log(`   +${String(s.t).padStart(4)}ms  菊花=${s.thinking ? 'ON ' : 'off'}  锁定=${s.disabled}  ${s.err ? `err="${s.err}"` : ''}`)
  const firstOn = seen.find((s) => s.thinking)
  const timeoutLine = seen.find((s) => s.err)
  const end = seen[seen.length - 1]
  check(!!firstOn && near(firstOn.t, SLOW, 120), `菊花在 ${SLOW}ms 出现`, `实测 ${firstOn?.t}ms`)
  check(!!timeoutLine && near(timeoutLine.t, ms.guess, 250), `猜词 ${ms.guess}ms 超时解锁`, `实测 ${timeoutLine?.t}ms`)
  check(timeoutLine?.err.includes('3 秒'), '提示文案是 3 秒', timeoutLine?.err)
  check(end.disabled === false && end.thinking === false, '超时后输入框解锁')
  check(!errs.length, '无 pageerror', errs.join(' | ') || undefined)
  await c.close()
}

// ---------- 2) 自由玩 · 问一问：8 秒 ----------
{
  await resetRoom()
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  // 判官未配置时前端会把问一问置灰，这里只验证超时接线：骗前端 judgeReady=true，再吞掉 ask 帧
  await c.addInitScript(() => {
    const Native = window.WebSocket
    class Slow extends Native {
      send(data) {
        try {
          const m = JSON.parse(data)
          if (m.type === 'ask') {
            window.__droppedAsk = (window.__droppedAsk || 0) + 1
            return
          }
        } catch {
          /* 非 JSON 原样发出 */
        }
        super.send(data)
      }
      set onmessage(fn) {
        super.onmessage = (ev) => {
          try {
            const m = JSON.parse(ev.data)
            if (m.type === 'state') m.judgeReady = true
            return fn({ ...ev, data: JSON.stringify(m) })
          } catch {
            return fn(ev)
          }
        }
      }
      get onmessage() {
        return super.onmessage
      }
    }
    window.WebSocket = Slow
  })
  const p = await c.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(B, { waitUntil: 'networkidle' })
  await p.waitForTimeout(1200)
  const askTab = p.locator('.mode-btn.main')
  await askTab.click()
  await p.waitForTimeout(200)
  const askEnabled = await askTab.isEnabled()
  await p.fill('.entry input', '它是吃的吗')
  await p.click('.entry button')
  const seen = await pollThinking(p, 9200)
  await p.screenshot({ path: '/tmp/xunci-thinking-ask.png' })
  console.log('\n[2] 自由玩 · 问一问 · 服务端不回：')
  for (const s of seen)
    console.log(`   +${String(s.t).padStart(4)}ms  菊花=${s.thinking ? 'ON ' : 'off'}  锁定=${s.disabled}  ${s.err ? `err="${s.err}"` : ''}`)
  const firstOn = seen.find((s) => s.thinking)
  const timeoutLine = seen.find((s) => s.err)
  const end = seen[seen.length - 1]
  check(askEnabled, '问一问入口可点（已骗过 judgeReady）')
  check(!!firstOn && near(firstOn.t, SLOW, 150), `菊花在 ${SLOW}ms 出现`, `实测 ${firstOn?.t}ms`)
  check(
    !!timeoutLine && timeoutLine.t > 7000 && timeoutLine.t < 8700,
    `问一问 ${ms.ask}ms 才超时（没有被 3 秒误杀）`,
    `实测 ${timeoutLine?.t}ms`,
  )
  check(timeoutLine?.err.includes('8 秒'), '提示文案是 8 秒', timeoutLine?.err)
  check(end.disabled === false && end.thinking === false, '超时后输入框解锁')
  check(!errs.length, '无 pageerror', errs.join(' | ') || undefined)
  await c.close()
}

// ---------- 3) 自由玩 · 正常猜词，不该闪 ----------
{
  await resetRoom()
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const p = await c.newPage()
  await p.goto(B, { waitUntil: 'networkidle' })
  await p.waitForTimeout(1200)
  await p.locator('.mode-btn', { hasText: '猜词' }).click()
  await p.waitForTimeout(200)
  await p.fill('.entry input', '月亮')
  await p.click('.entry button')
  const seen = await pollThinking(p, 1600)
  console.log('\n[3] 自由玩 · 正常猜词：')
  const flashes = seen.filter((s) => s.thinking).length
  check(flashes === 0, '菊花一次都没闪', `出现 ${flashes} 次`)
  await c.close()
}

// ---------- 4) 闯关 · REST 延迟 450ms ----------
{
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const p = await c.newPage()
  await p.route('**/api/challenge/guess', async (route) => {
    await new Promise((r) => setTimeout(r, 450))
    await route.continue()
  })
  await p.goto(B, { waitUntil: 'networkidle' })
  await p.waitForTimeout(900)
  await p.locator('.view-btn', { hasText: '闯关' }).click()
  await p.waitForTimeout(700)
  await p.getByText('吃喝日常', { exact: false }).first().click()
  await p.waitForTimeout(1500)
  // 判官可用时闯关默认「问一问」，这里测的是猜词超时，显式切到猜词
  await p.locator('.mode-btn', { hasText: '猜词' }).click()
  await p.waitForTimeout(200)
  await p.fill('.entry input', '米饭')
  await p.click('.entry button')
  const seen = await pollThinking(p, 2200)
  const on = seen.filter((s) => s.thinking)
  console.log('\n[4] 闯关 · 响应 450ms：')
  console.log(`   菊花 ${on[0]?.t ?? '—'}ms → ${on[on.length - 1]?.t ?? '—'}ms`)
  check(!!on.length && near(on[0].t, SLOW, 150), `菊花在 ${SLOW}ms 出现`, `实测 ${on[0]?.t}ms`)
  check(seen[seen.length - 1].thinking === false, '响应到达即收菊花')
  check(seen[seen.length - 1].disabled === false, '响应到达即解锁')
  await c.close()
}

// ---------- 5) 闯关 · REST 挂 5 秒 → 3 秒 abort ----------
{
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  // 直接在 fetch 的 signal 上打点：比 route.continue() 抛错更可靠地证明「真的取消了请求」
  await c.addInitScript(() => {
    const native = window.fetch
    window.__guessAbortAt = 0
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url ?? ''
      if (url.includes('/api/challenge/guess') && init?.signal) {
        init.signal.addEventListener('abort', () => {
          window.__guessAbortAt = Date.now()
        })
      }
      return native(input, init)
    }
  })
  const p = await c.newPage()
  await p.route('**/api/challenge/guess', async (route) => {
    await new Promise((r) => setTimeout(r, 5000))
    try {
      await route.abort()
    } catch {
      /* 页面已经取消，忽略 */
    }
  })
  await p.goto(B, { waitUntil: 'networkidle' })
  await p.waitForTimeout(900)
  await p.locator('.view-btn', { hasText: '闯关' }).click()
  await p.waitForTimeout(700)
  await p.getByText('吃喝日常', { exact: false }).first().click()
  await p.waitForTimeout(1500)
  await p.locator('.mode-btn', { hasText: '猜词' }).click()
  await p.waitForTimeout(200)
  await p.fill('.entry input', '面条')
  const tSubmit = await p.evaluate(() => Date.now())
  await p.click('.entry button')
  const seen = await pollThinking(p, 4500)
  const on = seen.filter((s) => s.thinking)
  const timeoutLine = seen.find((s) => s.err)
  console.log('\n[5] 闯关 · 响应 5s：')
  console.log(`   菊花 ${on[0]?.t ?? '—'}ms → ${on[on.length - 1]?.t ?? '—'}ms`)
  console.log(`   超时提示 ${timeoutLine?.t ?? '—'}ms：${timeoutLine?.err ?? '(无)'}`)
  check(!!on.length && near(on[0].t, SLOW, 150), `菊花在 ${SLOW}ms 出现`, `实测 ${on[0]?.t}ms`)
  check(!!timeoutLine && near(timeoutLine.t, ms.guess, 300), `猜词 ${ms.guess}ms 超时`, `实测 ${timeoutLine?.t}ms`)
  check(seen[seen.length - 1].disabled === false, '超时后输入解锁')
  const abortAt = await p.evaluate(() => window.__guessAbortAt)
  const abortDelay = abortAt ? abortAt - tSubmit : 0
  console.log(`   请求 abort：提交后 ${abortDelay || '—'}ms（期望 ≈${ms.guess}）`)
  check(abortAt > 0 && near(abortDelay, ms.guess, 500), 'AbortController 真的掐掉了请求', `实测 ${abortDelay}ms`)
  await c.close()
}

await b.close()
console.log(fails.length ? `\n失败 ${fails.length} 项：\n- ${fails.join('\n- ')}` : '\n全部通过')
process.exitCode = fails.length ? 1 : 0
