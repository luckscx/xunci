// 生成 docs 用的展示截图：找一局「篮球」，把爬升过程打出来（同时验证字面重叠打分）
import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:3111'
const TARGET = process.argv[2] || '篮球'
const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await c.newPage()
let answer = null
p.on('response', async (r) => {
  if (r.url().endsWith('/api/game')) {
    try { answer = (await r.json()).answer } catch { /* ignore */ }
  }
})
await p.goto(URL, { waitUntil: 'networkidle' })
await p.waitForSelector('.chip.cat')
await p.locator('.mode-btn', { hasText: '猜词' }).click()

for (let i = 0; i < 60 && answer !== TARGET; i++) {
  await p.click('.foot .ghost')
  await p.waitForTimeout(250)
}
console.log('当前答案', answer)
if (answer !== TARGET) { console.log('没抽到目标词，放弃'); await b.close(); process.exit(1) }

const ladder = TARGET === '篮球' ? ['排球', '球场', '球衣', '球', '篮板', '篮筐', '篮球鞋'] : ['排球', '球']
for (const w of ladder) {
  await p.fill('.entry input', w)
  await p.click('.entry button')
  await p.waitForTimeout(500)
  const [heat, verdict] = await p.evaluate(() => [
    document.querySelector('.num')?.textContent,
    document.querySelector('.verdict b')?.textContent,
  ])
  console.log(`${w.padEnd(4)} → ${heat} (${verdict})`)
}
await p.screenshot({ path: '/tmp/showcase-play.png' })

await p.fill('.entry input', TARGET)
await p.click('.entry button')
await p.waitForTimeout(1400)
await p.screenshot({ path: '/tmp/showcase-win.png' })
console.log('结算:', await p.evaluate(() => document.querySelector('.panel .sub')?.textContent))
await b.close()
