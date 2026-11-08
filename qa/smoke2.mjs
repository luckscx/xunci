// pull 之后：新主玩法（问一问）、闯关页、猜词兜底，三处冒烟
import { chromium } from 'playwright'

const B = 'http://127.0.0.1:3110'
const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await c.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()) })

await p.goto(B, { waitUntil: 'networkidle' })
await p.waitForTimeout(1400)

const head = async () => p.evaluate(() => ({
  brand: document.querySelector('.logo')?.textContent?.trim(),
  views: [...document.querySelectorAll('.view-btn, .mode-btn')].map((x) => x.textContent?.trim()).filter(Boolean),
  placeholder: document.querySelector('.entry input')?.getAttribute('placeholder'),
  docScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  footBottom: Math.round(document.querySelector('.foot')?.getBoundingClientRect().bottom ?? 0),
  vh: window.innerHeight,
}))
console.log('首屏:', JSON.stringify(await head()))
await p.screenshot({ path: '/tmp/xunci-pull2-room.png' })

// 默认主玩法（问一问）在没配 key 时的表现
const inp = await p.$('.entry input')
if (inp) {
  await p.fill('.entry input', '是动物吗')
  await p.click('.entry button')
  await p.waitForTimeout(2500)
  console.log('问一句报错:', await p.evaluate(() => document.querySelector('.err')?.textContent?.trim() || '(无提示)'))
}

// 切到猜词
const guessTab = p.getByText('猜词', { exact: false }).first()
await guessTab.click()
await p.waitForTimeout(600)
for (const w of ['汽车', '月亮']) {
  await p.fill('.entry input', w)
  await p.click('.entry button')
  await p.waitForTimeout(600)
}
console.log('猜词后:', await p.evaluate(() => ({
  num: document.querySelector('.num')?.textContent?.trim(),
  rows: document.querySelectorAll('.hlist li').length,
})))
await p.screenshot({ path: '/tmp/xunci-pull2-guess.png' })

// 闯关页
const chBtn = p.getByText('闯关', { exact: false }).first()
await chBtn.click()
await p.waitForTimeout(1500)
const ch = await p.evaluate(() => ({
  text: document.querySelector('.app')?.innerText?.replace(/\s+/g, ' ').slice(0, 260),
  docScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
}))
console.log('闯关页:', JSON.stringify(ch))
await p.screenshot({ path: '/tmp/xunci-pull2-challenge.png' })

console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no console errors')
await b.close()
