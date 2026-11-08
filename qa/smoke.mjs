// pull 之后的冒烟：双玩法 UI 能开、分类门槛还在、无控制台报错
import { chromium } from 'playwright'

const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await c.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()) })

await p.goto('http://127.0.0.1:3110', { waitUntil: 'networkidle' })
await p.waitForTimeout(1200)

const state = await p.evaluate(() => {
  const d = document.documentElement
  const foot = document.querySelector('.foot')?.getBoundingClientRect()
  return {
    title: document.querySelector('.logo')?.textContent?.trim(),
    catChip: document.querySelector('.chip.cat')?.textContent?.trim(),
    catClass: document.querySelector('.chip.cat')?.className,
    modes: [...document.querySelectorAll('button, .mode, .tab')].map((x) => x.textContent?.trim()).filter(Boolean).slice(0, 12),
    docScroll: d.scrollHeight - d.clientHeight,
    footBottom: foot ? Math.round(foot.bottom) : null,
    vh: window.innerHeight,
  }
})
console.log(JSON.stringify(state, null, 1))

await p.screenshot({ path: '/tmp/ciwen-pull-idle.png' })

// 猜 3 个词，看热度反馈是否正常
for (const w of ['汽车', '钢琴', '苹果']) {
  const inp = await p.$('.entry input')
  if (!inp) { console.log('找不到输入框'); break }
  await p.fill('.entry input', w)
  await p.click('.entry button')
  await p.waitForTimeout(500)
}
const after = await p.evaluate(() => ({
  num: document.querySelector('.num')?.textContent?.trim(),
  verdict: document.querySelector('.verdict')?.textContent?.trim(),
  tally: document.querySelector('.tally')?.textContent?.replace(/\s+/g, ' ').trim(),
  rows: document.querySelectorAll('.hlist li').length,
}))
console.log('猜 3 次后:', JSON.stringify(after))
await p.screenshot({ path: '/tmp/ciwen-pull-play.png' })

console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no console errors')
await b.close()
