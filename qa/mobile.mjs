// 手机端布局与流程验证：多尺寸检查是否有滚动/裁切，并截图留证
import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5183'
const SIZES = [
  { name: 'iphone12', w: 390, h: 844 },
  { name: 'small', w: 360, h: 640 },
  { name: 'tall', w: 414, h: 896 },
]

const browser = await chromium.launch()
const errors = []

for (const s of SIZES) {
  const ctx = await browser.newContext({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${s.name}] console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[${s.name}] pageerror: ${e.message}`))

  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.chips .chip.cat:not(:empty)', { timeout: 30000 })
  await page.waitForTimeout(400)

  const box = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollHeight,
    docClient: document.documentElement.clientHeight,
    bodyOverflow: getComputedStyle(document.body).overflow,
    bodyScroll: document.body.scrollHeight,
    footBottom: Math.round(document.querySelector('.foot').getBoundingClientRect().bottom),
    inputBottom: Math.round(document.querySelector('.entry').getBoundingClientRect().bottom),
    hlistH: Math.round(document.querySelector('.hlist')?.getBoundingClientRect().height ?? 0),
    vh: window.innerHeight,
  }))
  console.log(s.name, JSON.stringify(box))
  if (box.docScroll !== box.docClient) console.log(`  ⚠️ ${s.name} 文档出现滚动`)
  if (box.footBottom > box.vh + 0.5) console.log(`  ⚠️ ${s.name} 底栏超出视口 ${box.footBottom} > ${box.vh}`)
  await page.screenshot({ path: `/tmp/ciwen-${s.name}-idle.png` })

  // 猜几个词
  const words = ['猫', '钢琴', '自由', '医院', '面包']
  for (const w of words) {
    await page.fill('.entry input', w)
    await page.click('.entry button')
    await page.waitForTimeout(320)
  }
  const rows = await page.evaluate(() => document.querySelectorAll('.hlist li').length)
  const pct = await page.evaluate(() => document.querySelector('.num')?.textContent)
  console.log(`  ${s.name} 历史 ${rows} 行, 当前数字 ${pct}`)
  await page.screenshot({ path: `/tmp/ciwen-${s.name}-play.png` })

  // 布局压力测试：多猜几个词后是否仍不滚动
  for (const w of ['苹果', '西瓜', '地铁', '股票', '婚礼', '台风', '吉他']) {
    await page.fill('.entry input', w)
    await page.click('.entry button')
    await page.waitForTimeout(180)
  }
  const after = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollHeight,
    docClient: document.documentElement.clientHeight,
    footBottom: Math.round(document.querySelector('.foot').getBoundingClientRect().bottom),
    vh: window.innerHeight,
    hlistScroll: document.querySelector('.hlist')?.scrollHeight,
    hlistClient: document.querySelector('.hlist')?.clientHeight,
  }))
  console.log(`  ${s.name} 多行后`, JSON.stringify(after))
  if (after.docScroll !== after.docClient) console.log(`  ⚠️ ${s.name} 多行后文档滚动`)
  if (after.footBottom > after.vh + 0.5) console.log(`  ⚠️ ${s.name} 多行后底栏越界`)
  await page.screenshot({ path: `/tmp/ciwen-${s.name}-many.png` })

  // 结束态：放弃 → 覆盖层（服务端可能关闭「看答案」，此时跳过）
  const danger = page.locator('.foot .danger')
  if (await danger.isEnabled()) {
    await danger.click()
    await page.waitForTimeout(700)
    const overlay = await page.evaluate(() => {
      const p = document.querySelector('.overlay .panel')
      if (!p) return null
      const r = p.getBoundingClientRect()
      return { answer: document.querySelector('.answer')?.textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight }
    })
    console.log(`  ${s.name} 结算层`, JSON.stringify(overlay))
    await page.screenshot({ path: `/tmp/ciwen-${s.name}-over.png` })
  } else {
    console.log(`  ${s.name} 服务端关闭了「看答案」，跳过结算层检查`)
  }

  await ctx.close()
}

console.log(errors.length ? '错误:\n' + errors.join('\n') : '控制台无错误')
await browser.close()
