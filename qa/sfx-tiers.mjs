// 用带答案的本地服务验证"不同热度段 → 不同音型"
// 需要：PORT=3111 CIWEN_DEV_HINT=1 node server/index.js
import { chromium } from 'playwright'
import { WORD_POOL } from '../server/words.js'

const URL = 'http://127.0.0.1:3111'
const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const p = await c.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })

await p.addInitScript(() => {
  const orig = AudioContext.prototype.createOscillator
  window.__osc = []
  AudioContext.prototype.createOscillator = function () {
    const osc = orig.call(this)
    const rec = { f: null, type: null }
    window.__osc.push(rec)
    const setV = osc.frequency.setValueAtTime.bind(osc.frequency)
    osc.frequency.setValueAtTime = (v, t) => {
      rec.f = Math.round(v)
      return setV(v, t)
    }
    Object.defineProperty(osc, 'type', {
      get: () => rec.type,
      set: (v) => { rec.type = v },
    })
    return osc
  }
})

let answer = null
let category = null
p.on('response', async (res) => {
  if (res.url().endsWith('/api/game') && res.request().method() === 'POST') {
    try {
      const j = await res.json()
      answer = j.answer
      category = j.category
    } catch { /* ignore */ }
  }
})

await p.goto(URL, { waitUntil: 'networkidle' })
await p.waitForSelector('.chip.cat')
await p.locator('.mode-btn', { hasText: '猜词' }).click()
await p.waitForTimeout(300)
console.log('本局答案（QA 可见）:', answer, '/ 分类', category)

const siblings = WORD_POOL.filter((x) => x.c === category && x.w !== answer).map((x) => x.w)
const plan = [...siblings.slice(0, 5), answer]

const rows = []
for (const w of plan) {
  const before = await p.evaluate(() => window.__osc.length)
  await p.fill('.entry input', w)
  await p.click('.entry button')
  await p.waitForTimeout(1100)
  const osc = await p.evaluate((n) => window.__osc.slice(n), before)
  const heat = await p.evaluate(() => document.querySelector('.num')?.textContent)
  const verdict = await p.evaluate(() => document.querySelector('.verdict b')?.textContent)
  // 去掉 tap 音（1180Hz square 单个），保留结果音
  const motif = osc.length > 1 ? osc.slice(1) : []
  rows.push({ w, heat, verdict, motif })
  console.log(`${w.padEnd(4)} ${String(heat).padEnd(8)} ${String(verdict).padEnd(6)} → ${motif.map((o) => `${o.f}Hz/${o.type}`).join(' ')}`)
  if (w === answer) break
}

const sigs = new Set(rows.filter((r) => r.motif.length).map((r) => r.motif.map((o) => o.f).join(',')))
console.log(`不同音型 ${sigs.size} 种 / ${rows.filter((r) => r.motif.length).length} 次有效结果`)
await p.screenshot({ path: '/tmp/ciwen-sfx-win.png' })
console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no console errors')
await b.close()
