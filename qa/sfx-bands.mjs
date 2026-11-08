// 直接调用 sfx 模块，逐个热度段验证音型（走 Vite dev server，可动态 import 源模块）
import { chromium } from 'playwright'

const URL = process.env.URL || 'http://127.0.0.1:5183'
const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 390, height: 844 } })
const p = await c.newPage()
await p.addInitScript(() => {
  const orig = AudioContext.prototype.createOscillator
  window.__osc = []
  AudioContext.prototype.createOscillator = function () {
    const osc = orig.call(this)
    const rec = { f: null, type: null }
    window.__osc.push(rec)
    const setV = osc.frequency.setValueAtTime.bind(osc.frequency)
    osc.frequency.setValueAtTime = (v, t) => { rec.f = Math.round(v); return setV(v, t) }
    Object.defineProperty(osc, 'type', { get: () => rec.type, set: (v) => { rec.type = v } })
    return osc
  }
})
await p.goto(URL, { waitUntil: 'networkidle' })
await p.waitForSelector('.chip.cat')

const out = await p.evaluate(async () => {
  const sfx = await import('/src/sfx.ts')
  const res = {}
  for (const band of [0, 6, 15, 28, 44, 58, 72, 88, 97, 100]) {
    const before = window.__osc.length
    sfx.playTier(band)
    res[band] = window.__osc.slice(before).map((o) => `${o.f}/${o.type}`)
  }
  return res
})

for (const [band, motif] of Object.entries(out)) {
  console.log(`${String(band).padStart(3)} 热度 → ${motif.join(' ')}`)
}
const sigs = new Set(Object.values(out).map((m) => m.join(',')))
console.log(`\n${Object.keys(out).length} 个热度段 → ${sigs.size} 种不同音型`)
await b.close()
