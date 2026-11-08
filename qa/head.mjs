// 顶栏与玩法切换布局：静音按钮不越界，焦点卡不再有刻度
import { chromium } from 'playwright'
const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
const p = await c.newPage()
await p.goto('http://127.0.0.1:3110', { waitUntil: 'networkidle' })
await p.waitForSelector('.chip.cat')
await p.locator('.mode-btn', { hasText: '猜词' }).click()
await p.fill('.entry input', '琴')
await p.click('.entry button')
await p.waitForTimeout(900)
await p.screenshot({ path: '/tmp/xunci-head.png', clip: { x: 0, y: 0, width: 390, height: 300 } })
console.log(await p.evaluate(() => {
  const r = document.querySelector('.snd').getBoundingClientRect()
  return JSON.stringify({ snd: [Math.round(r.left), Math.round(r.right)], vw: innerWidth, ticks: document.querySelectorAll('.thermo .tick').length })
}))
await b.close()
