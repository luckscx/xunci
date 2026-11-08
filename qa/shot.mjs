import { chromium } from 'playwright'

const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await c.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })

await p.goto('http://127.0.0.1:3110', { waitUntil: 'networkidle' })
await p.waitForSelector('.chip.cat')
await p.waitForTimeout(400)
await p.screenshot({ path: '/tmp/ciwen-xunci-idle.png' })

for (const w of ['狗', '宠物', '小猫', '钢琴']) {
  await p.fill('.entry input', w)
  await p.click('.entry button')
  await p.waitForTimeout(400)
}
await p.screenshot({ path: '/tmp/ciwen-xunci-play.png' })

// 放弃 → 结算层
await p.click('.foot .danger')
await p.waitForTimeout(800)
await p.screenshot({ path: '/tmp/ciwen-xunci-over.png' })

console.log('rows', await p.evaluate(() => document.querySelectorAll('.hlist li').length))
console.log('num', await p.evaluate(() => document.querySelector('.num')?.textContent))
console.log('overlay answer', await p.evaluate(() => document.querySelector('.answer')?.textContent))
console.log('overlay sub', await p.evaluate(() => document.querySelector('.panel .sub')?.textContent))
console.log('scroll ok', await p.evaluate(() => document.documentElement.scrollHeight === document.documentElement.clientHeight))
console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no console errors')
await b.close()
