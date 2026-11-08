// 输入框位置 + 键盘弹出稳定性回归
//   node qa/keyboard.mjs   （默认 http://127.0.0.1:3110，URL= 覆盖）
//
// 验两件事：
//   1) 输入框落在屏幕上半部分（top < 50% 视口高）——否则手机点输入时页面要滚动把它顶上来
//   2) 模拟键盘弹出（视口高度减少 300–380px）时，输入框位移为 0，且自己仍在可视区
import { chromium } from 'playwright'

const B = process.env.URL || 'http://127.0.0.1:3110'
const CASES = [
  { name: '390x844', w: 390, h: 844, kb: 360 },
  { name: '360x640', w: 360, h: 640, kb: 300 },
  { name: '414x896', w: 414, h: 896, kb: 380 },
]

const fails = []
const check = (ok, label, detail) => {
  console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails.push(label)
}

async function resetRoom() {
  const r = await fetch(`${B}/api/game`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!r.ok) throw new Error(`重置对局失败 HTTP ${r.status}`)
}

const b = await chromium.launch()
await resetRoom()

for (const cs of CASES) {
  await resetRoom()
  const c = await b.newContext({
    viewport: { width: cs.w, height: cs.h },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  const p = await c.newPage()
  await p.goto(B, { waitUntil: 'networkidle' })
  await p.waitForTimeout(900)

  // 猜词模式下先攒几条记录，让列表有内容（列表有内容时布局才最容易被顶动）
  // 答案随机，偶尔第一个词就蹭到 100 把局结束——那样输入框会禁用，攒够就停
  await p.locator('.mode-btn', { hasText: '猜词' }).click()
  for (const w of ['猫', '汽车', '钢琴']) {
    const off = await p.evaluate(() => document.querySelector('.entry input')?.disabled ?? true)
    if (off) break
    await p.fill('.entry input', w)
    await p.click('.entry button')
    await p.waitForTimeout(280)
  }

  const snap = () =>
    p.evaluate(() => {
      const el = document.querySelector('.entry input')
      const box = el.getBoundingClientRect()
      const gauge = document.querySelector('.gauge').getBoundingClientRect()
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        gaugeH: Math.round(gauge.height),
        compact: document.querySelector('.app').classList.contains('compact'),
        docScroll: document.documentElement.scrollHeight,
        vh: window.innerHeight,
        focused: el === document.activeElement,
      }
    })

  const before = await snap()
  await p.setViewportSize({ width: cs.w, height: cs.h - cs.kb })
  await p.waitForTimeout(350)
  const during = await snap()
  await p.setViewportSize({ width: cs.w, height: cs.h })
  await p.waitForTimeout(350)
  const after = await snap()
  await p.screenshot({ path: `/tmp/xunci-kb-${cs.name}.png` })

  console.log(`\n[${cs.name}] 键盘 -${cs.kb}px（compact=${before.compact}）`)
  console.log(`   输入框 top: ${before.top} → ${during.top} → ${after.top}（视口 ${before.vh}/${during.vh}）`)
  console.log(`   焦点卡高: ${before.gaugeH} → ${during.gaugeH}  列表高: ${before.docScroll}/${during.docScroll}`)

  const pct = (before.top / before.vh) * 100
  check(pct < 50, `输入框在上半部分`, `top ${before.top} = ${pct.toFixed(0)}% 视口高`)
  check(during.top === before.top, '键盘弹出时输入框不位移', `${before.top} → ${during.top}`)
  check(after.top === before.top, '键盘收起后回到原位', `${after.top}`)
  check(during.bottom <= during.vh, '键盘弹出时输入框仍完整可见', `底 ${during.bottom} ≤ ${during.vh}`)
  check(before.gaugeH === during.gaugeH, '焦点卡高度不变（紧凑样式不跟键盘切换）', `${before.gaugeH} → ${during.gaugeH}`)
  check(before.docScroll === before.vh, '页面无整体滚动', `${before.docScroll}/${before.vh}`)

  await c.close()
}

await b.close()
console.log(fails.length ? `\n失败 ${fails.length} 项：\n- ${fails.join('\n- ')}` : '\n全部通过')
process.exitCode = fails.length ? 1 : 0
