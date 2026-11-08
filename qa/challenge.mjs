// 闯关模式 UI 验收：模式切换 → 选领域 → 连闯 4 题 → 结算上榜 → 榜单可见。
// 需要服务端带 XUNCI_DEV_HINT=1 启动，脚本通过接口读答案走完整流程。
// BASE_URL=http://127.0.0.1:3111 XUNCI_DEV_HINT=1 node qa/challenge.mjs
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3110'
const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await c.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
const ok = (cond, label, extra = '') => console.log(cond ? `PASS ${label}` : `FAIL ${label}`, extra ? JSON.stringify(extra) : '')

await p.goto(BASE, { waitUntil: 'networkidle' })
await p.waitForSelector('.views .view-btn')
ok((await p.locator('.views .view-btn').count()) === 2, '顶栏两个模式')
ok((await p.locator('.tally b').count()) === 1, '自由玩视图保留次数显示')

await p.locator('.views .view-btn').nth(1).click()
await p.waitForSelector('.cat-grid .cat-btn')
const n = await p.locator('.cat-grid .cat-btn').count()
ok(n === 8, '聚合后 8 个领域', n)
ok((await p.locator('.cat-btn .grp').count()) === 8, '每张卡展示聚合的小类')
const dom = await p.evaluate(async () => (await (await fetch('/api/challenge/categories')).json()).domains)
ok(dom.reduce((s, d) => s + d.count, 0) === 239, '8 个领域覆盖词库全部词', dom.map((d) => d.count))
const legacy = await p.evaluate(async () => (await fetch('/api/challenge/start', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ category: '动物', playerId: 'qa-legacy' }),
})).status)
ok(legacy === 200, '旧细分分类名仍可开局（兼容）')
ok((await p.locator('.rule-note').textContent())?.includes('综合分'), '规则说明含综合分')

await p.locator('.cat-grid .cat-btn').first().click()
await p.waitForSelector('.run-head')
ok((await p.locator('.steps .step').count()) === 4, '4 关进度条')
ok((await p.locator('.hud').textContent())?.includes('问'), 'HUD 展示问句额度')
const judgeReady = await p.evaluate(async () => (await (await fetch('/api/challenge/categories')).json()).judgeReady)
ok(judgeReady, '判官可用（服务端需配置 TYPESAFE_API_KEY）')
ok((await p.locator('.modes .mode-btn.on').textContent())?.includes('问一句'), '闯关默认主玩法是问一问')
ok((await p.locator('.modes .mode-btn').nth(1).textContent())?.includes('猜词'), '猜词作为收尾玩法可见')

// 问一问链路：判官回答 + 记入列表
await p.fill('.entry input', '它是动物吗？')
await p.click('.entry button')
await p.waitForSelector('.hlist .qv', { timeout: 30000 })
ok((await p.locator('.hlist .qv').count()) === 1, '判官回答记入问答列表')
ok((await p.locator('.hhead').textContent())?.includes('是非题'), '问一问模式下展示问答列表')
const id = await p.evaluate(() => localStorage.getItem('xunci.challenge.v1'))
ok(!!id, '未完成挑战写入本地会话')

const st = await p.evaluate(async (sid) => {
  const r = await fetch('/api/challenge/session?id=' + encodeURIComponent(sid))
  return r.json()
}, id)
ok(st.devAnswers?.length === 4, '接口可读到 4 道题答案')

// 切到猜词收尾，用调试答案通关
await p.locator('.modes .mode-btn', { hasText: '猜词' }).click()
for (let i = 0; i < st.devAnswers.length; i++) {
  await p.fill('.entry input', st.devAnswers[i])
  await p.click('.entry button')
  await p.waitForTimeout(300)
  if (i < 3) ok((await p.locator('.steps .step.cleared').count()) === i + 1, `第 ${i + 1} 题后进度更新`)
}
await p.waitForSelector('.result-panel')
ok((await p.locator('.verdict-badge').textContent())?.includes('领域专家'), '通关授予领域专家')
ok((await p.locator('.score-line').textContent())?.includes('综合分'), '结算展示综合分')
ok((await p.locator('.answers span').count()) === 4, '结算揭晓 4 个答案')
const sub = await p.locator('.result-panel .sub').textContent()
ok(sub?.includes('问了') && sub?.includes('猜了'), '结算展示问与猜的步数', sub)

await p.locator('.panel-links .ghost').first().click()
await p.waitForSelector('.board-list')
await p.waitForSelector('.board-list .rk')
ok((await p.locator('.board-list li.me').count()) === 1, '领域榜高亮自己')
await p.screenshot({ path: '/tmp/xunci-challenge-board.png' })

for (const [w, h] of [[390, 844], [360, 640], [414, 896]]) {
  await p.setViewportSize({ width: w, height: h })
  await p.waitForTimeout(250)
  const box = await p.evaluate(() => {
    const d = document.documentElement
    return { scrollY: d.scrollHeight - d.clientHeight }
  })
  ok(box.scrollY === 0, `${w}x${h} 无文档滚动`, box)
}

console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no console errors')
await b.close()
