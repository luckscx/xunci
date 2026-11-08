import { chromium } from 'playwright'
const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await c.newPage()
await p.goto('http://127.0.0.1:3110', { waitUntil: 'networkidle' })
await p.waitForSelector('.chip.cat')
await p.locator('.mode-btn', { hasText: '猜词' }).click()
let tries = 0
while (tries < 40) {
  const cat = await p.evaluate(() => document.querySelector('.chip.cat')?.textContent || '')
  if (cat.includes('热梗')) break
  await p.click('.foot .ghost')
  await p.waitForTimeout(280)
  tries++
}
console.log('轮换次数', tries, await p.evaluate(() => document.querySelector('.chip.cat')?.textContent))
for (const w of ['打工人', '上班', '加班']) {
  await p.fill('.entry input', w); await p.click('.entry button'); await p.waitForTimeout(450)
}
await p.screenshot({ path: '/tmp/ciwen-hot.png' })
console.log('num', await p.evaluate(() => document.querySelector('.num')?.textContent))
await b.close()
