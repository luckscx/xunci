// 验证分类提示：按「问 + 猜」总步数达到 categoryAt 后解锁（切到辅助玩法猜词推进）
import { chromium } from 'playwright'

const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await c.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })

const words = ['汽车', '钢琴', '苹果', '足球', '医生', '银行', '月亮', '雨伞', '火车', '面包', '沙发', '啤酒']

await p.goto('http://127.0.0.1:3110', { waitUntil: 'networkidle' })
await p.waitForSelector('.chip.cat')
await p.locator('.mode-btn', { hasText: '猜词' }).click()

const chip = () =>
  p.evaluate(() => {
    const el = document.querySelector('.chip.cat')
    const cs = el ? getComputedStyle(el) : null
    return {
      text: el?.textContent?.trim(),
      locked: el?.classList.contains('locked') ?? null,
      unlocked: el?.classList.contains('unlocked') ?? null,
      borderStyle: cs?.borderTopStyle,
      color: cs?.color,
      overflow: (() => {
        const c2 = document.querySelector('.chips')
        return c2 ? c2.scrollWidth - c2.clientWidth : 0
      })(),
    }
  })

console.log('开局:', JSON.stringify(await chip()))
await p.screenshot({ path: '/tmp/ciwen-cat-locked.png' })

for (let i = 0; i < 9; i++) {
  await p.fill('.entry input', words[i])
  await p.click('.entry button')
  await p.waitForTimeout(260)
  if (i === 4) console.log('第 5 次:', JSON.stringify(await chip()))
}
console.log('第 9 次:', JSON.stringify(await chip()))

await p.fill('.entry input', words[9])
await p.click('.entry button')
await p.waitForTimeout(300)
console.log('第 10 次:', JSON.stringify(await chip()))
await p.screenshot({ path: '/tmp/ciwen-cat-unlocked.png' })

await p.fill('.entry input', words[10])
await p.click('.entry button')
await p.waitForTimeout(300)
console.log('第 11 次:', JSON.stringify(await chip()))

// 布局：三个机型都不许出现文档滚动 / 底栏越界
for (const [w, h] of [[390, 844], [360, 640], [414, 896]]) {
  await p.setViewportSize({ width: w, height: h })
  await p.waitForTimeout(250)
  const box = await p.evaluate(() => {
    const d = document.documentElement
    const foot = document.querySelector('.foot').getBoundingClientRect()
    return { scrollY: d.scrollHeight - d.clientHeight, bodyOverflow: getComputedStyle(document.body).overflow, footBottom: Math.round(foot.bottom), vh: window.innerHeight }
  })
  console.log(`${w}x${h}:`, JSON.stringify(box))
}

console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no console errors')
await b.close()
