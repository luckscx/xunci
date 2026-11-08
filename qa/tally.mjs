// 验证会话信息条：开始时间、用时（真的在走）、已猜次数
import { chromium } from 'playwright'

const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await c.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })

await p.goto('http://127.0.0.1:3110', { waitUntil: 'networkidle' })
await p.waitForSelector('.tally')
const read = () =>
  p.evaluate(() => {
    const t = document.querySelector('.tally')?.textContent?.replace(/\s+/g, ' ').trim()
    return t
  })

console.log('刚开局:', await read())
await p.waitForTimeout(3200)
console.log('等 3.2 秒:', await read())

for (const w of ['猫', '狗', '钢琴']) {
  await p.fill('.entry input', w)
  await p.click('.entry button')
  await p.waitForTimeout(420)
}
console.log('猜 3 次后:', await read())

// 重置后应归零
await p.click('.foot .ghost')
await p.waitForTimeout(700)
console.log('换一局后:', await read())

await p.screenshot({ path: '/tmp/ciwen-tally.png' })
console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no console errors')
await b.close()
