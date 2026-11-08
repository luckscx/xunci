// 验证音效真的被调度：拦截 AudioContext，记录每次创建的振荡器频率
import { chromium } from 'playwright'

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
      get() {
        return rec.type
      },
      set(v) {
        rec.type = v
      },
    })
    return osc
  }
})

await p.goto('http://127.0.0.1:3110', { waitUntil: 'networkidle' })
await p.waitForSelector('.chip.cat')
await p.locator('.mode-btn', { hasText: '猜词' }).click()

async function guess(word) {
  const before = await p.evaluate(() => window.__osc.length)
  await p.fill('.entry input', word)
  await p.click('.entry button')
  await p.waitForTimeout(1000)
  const osc = await p.evaluate((n) => window.__osc.slice(n), before)
  const pct = await p.evaluate(() => document.querySelector('.num')?.textContent)
  return { word, pct, osc }
}

const results = []
const words = ['猫', '钢琴', '自由', '医院', '面包', '西瓜', '地铁']
for (const w of words) {
  const r = await guess(w)
  results.push(r)
  console.log(`${r.word}  ${r.pct}  →  ${r.osc.filter((o) => o.f).map((o) => `${o.f}Hz/${o.type}`).join(' ')}`)
}

// 音色差异检查：不同热度段应当是不同的音高集合
const sets = new Set(results.filter((r) => r.osc.length).map((r) => r.osc.map((o) => o.f).join(',')))
console.log('不同音型数量:', sets.size, '/', results.filter((r) => r.osc.length).length)

// 静音后不应再创建振荡器
await p.click('.snd')
const mutedBefore = await p.evaluate(() => window.__osc.length)
await p.fill('.entry input', '月亮')
await p.click('.entry button')
await p.waitForTimeout(900)
const mutedAfter = await p.evaluate(() => window.__osc.length)
console.log('静音后新增振荡器:', mutedAfter - mutedBefore, mutedAfter === mutedBefore ? '✓ 静音生效' : '✗ 静音无效')

// 恢复
await p.click('.snd')
const r2 = await guess('太阳')
console.log('恢复后', r2.pct, '振荡器', r2.osc.length, r2.osc.length > 0 ? '✓' : '✗')

await p.screenshot({ path: '/tmp/xunci-sfx.png' })
console.log(errs.length ? 'ERR ' + errs.join(' | ') : 'no console errors')
await b.close()
