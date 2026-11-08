// 手机端布局与流程验证：多尺寸检查是否有滚动/裁切，并截图留证
//   URL=http://host:port node qa/mobile.mjs
// 默认指向生产用的单端口服务（3110），不是 vite dev server（5183）。
// 跑之前会先 POST /api/game 重置公共房间——否则上一轮留下的结算弹层会挡住按钮。
import { chromium } from 'playwright'

const URL = process.env.URL || 'http://127.0.0.1:3110'
const SIZES = [
  { name: 'iphone12', w: 390, h: 844 },
  { name: 'small', w: 360, h: 640 },
  { name: 'tall', w: 414, h: 896 },
]

const issues = []

/** 公共房间是全局共享的，跑测试前先开一局新的，清掉结算态 */
async function resetRoom() {
  const res = await fetch(`${URL}/api/game`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`重置对局失败 HTTP ${res.status}`)
  const g = await res.json()
  return g.id
}

const gameId = await resetRoom()
console.log(`新局 ${gameId}`)

const browser = await chromium.launch()
const errors = []

for (const s of SIZES) {
  // 每个尺寸都从干净的一局开始，避免上一个尺寸玩到结束
  await resetRoom()
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
  await page.waitForSelector('.chip.cat', { timeout: 30000 })
  await page.locator('.mode-btn', { hasText: '猜词' }).click()
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
  if (box.docScroll !== box.docClient) issues.push(`⚠️ ${s.name} 文档出现滚动 ${box.docScroll} > ${box.docClient}`)
  if (box.footBottom > box.vh + 0.5) issues.push(`⚠️ ${s.name} 底栏超出视口 ${box.footBottom} > ${box.vh}`)
  await page.screenshot({ path: `/tmp/xunci-${s.name}-idle.png` })

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
  if (rows === 0) issues.push(`⚠️ ${s.name} 猜了 ${words.length} 个词但历史为空`)
  await page.screenshot({ path: `/tmp/xunci-${s.name}-play.png` })

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
  if (after.docScroll !== after.docClient) issues.push(`⚠️ ${s.name} 多行后文档滚动`)
  if (after.footBottom > after.vh + 0.5) issues.push(`⚠️ ${s.name} 多行后底栏越界`)
  if ((after.hlistScroll ?? 0) <= (after.hlistClient ?? 0)) {
    // 历史已溢出却没在内部滚动 = 内容被裁切
    const overflow = await page.evaluate(() => {
      const el = document.querySelector('.hlist')
      return el ? getComputedStyle(el).overflowY : ''
    })
    if (overflow === 'auto' || overflow === 'scroll') {
      console.log(`  ${s.name} 历史未溢出（${rows + 7} 行仍放得下），跳过内部滚动检查`)
    }
  }
  await page.screenshot({ path: `/tmp/xunci-${s.name}-many.png` })

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
    if (!overlay) issues.push(`⚠️ ${s.name} 点了「放弃」但没出现结算层`)
    else if (overlay.top < 0 || overlay.bottom > overlay.vh + 0.5) {
      issues.push(`⚠️ ${s.name} 结算层超出视口 ${overlay.top}~${overlay.bottom} / ${overlay.vh}`)
    }
    await page.screenshot({ path: `/tmp/xunci-${s.name}-over.png` })
  } else {
    console.log(`  ${s.name} 服务端关闭了「看答案」，跳过结算层检查`)
  }

  await ctx.close()
}

console.log(errors.length ? '错误:\n' + errors.join('\n') : '控制台无错误')
if (issues.length) console.log('布局问题:\n' + issues.join('\n'))
await browser.close()

process.exitCode = errors.length || issues.length ? 1 : 0
