// 出图：把全局房间的目标词刷成"玫瑰"，再在浏览器里走一条真实的猜测路径
import { chromium } from 'playwright'

const B = 'http://127.0.0.1:3111'
const post = (p, b) =>
  fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json())

let target = ''
for (let i = 0; i < 3000; i++) {
  const g = await post('/api/game')
  if (g.answer === '玫瑰') { target = g.answer; break }
}
console.log('目标锁定:', target || '未刷到')

const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await c.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
await p.goto(B, { waitUntil: 'networkidle' })
await p.waitForTimeout(1200)
await p.locator('.mode-btn', { hasText: '猜词' }).click()

for (const w of ['情人节', '花', '刺', '月季']) {
  await p.fill('.entry input', w)
  await p.click('.entry button')
  await p.waitForTimeout(700)
}
await p.screenshot({ path: '/tmp/xunci-assoc-play.png' })
const rows = await p.evaluate(() => [...document.querySelectorAll('.hlist li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()))
console.log('榜单:', JSON.stringify(rows))
console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no console errors')
await b.close()
