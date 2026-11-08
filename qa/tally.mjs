// 验证顶栏「还剩 N 次」：随猜测递减，换局归零
import { chromium } from 'playwright'

const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await c.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })

await p.goto('http://127.0.0.1:3110', { waitUntil: 'networkidle' })
await p.waitForSelector('.tally')
await p.locator('.mode-btn', { hasText: '猜词' }).click()
const read = () => p.evaluate(() => Number(document.querySelector('.tally b')?.textContent ?? -1))

const first = await read()
console.log('刚开局剩余:', first)

for (const w of ['猫', '狗', '钢琴']) {
  await p.fill('.entry input', w)
  await p.click('.entry button')
  await p.waitForTimeout(420)
}
const after = await read()
console.log('猜 3 次后剩余:', after, after === first - 3 ? '✓' : '✗ 次数没有正确递减')

// 换局后应回到上限
await p.click('.foot .ghost')
await p.waitForTimeout(700)
const reset = await read()
console.log('换一局后剩余:', reset, reset === first ? '✓' : '✗ 没有归零')

await p.screenshot({ path: '/tmp/xunci-tally.png' })
console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no console errors')
await b.close()
