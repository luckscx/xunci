// 诊断：为什么玩家永远拿到五十几六十几，然后一下子跳到 100
// 对每个目标词，把整个词池都算一遍，看 raw cos 的实际分布 vs 现有曲线映射后的热度分布
import { init, embedWord, baseline, overlap, score } from '../server/embedder.js'
import { WORD_POOL } from '../server/words.js'

await init()
const words = WORD_POOL.map((x) => x.w)
const vecs = new Map()
for (const w of words) vecs.set(w, await embedWord(w))

const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

const BANDS = [
  ['0-8', (p) => p <= 8],
  ['9-20', (p) => p > 8 && p <= 20],
  ['21-35', (p) => p > 20 && p <= 35],
  ['36-50', (p) => p > 35 && p <= 50],
  ['51-65', (p) => p > 50 && p <= 65],
  ['66-80', (p) => p > 65 && p <= 80],
  ['81-94', (p) => p > 80 && p <= 94],
  ['95-99', (p) => p > 94 && p <= 99],
]

const bandCount = Object.fromEntries(BANDS.map(([k]) => [k, 0]))
let pairs = 0
let maxRaw = 0
const rawAll = []
const perTargetTop = []

for (const t of words) {
  const tv = vecs.get(t)
  const base = await baseline(tv)
  let best = 0
  let bestW = ''
  for (const g of words) {
    if (g === t) continue
    const raw = cos(tv, vecs.get(g))
    const pct = Math.min(99, score(raw, base, overlap(t, g)))
    pairs++
    rawAll.push(raw)
    for (const [k, f] of BANDS) if (f(pct)) bandCount[k]++
    if (raw > best) { best = raw; bestW = g }
  }
  if (best > maxRaw) maxRaw = best
  perTargetTop.push({ t, best, bestW, base })
}

rawAll.sort((a, b) => a - b)
const q = (p) => rawAll[Math.floor(rawAll.length * p)].toFixed(3)

console.log(`样本：${words.length} 个目标 × 其余词 = ${pairs} 对`)
console.log(`raw cos 分位: p50=${q(0.5)} p90=${q(0.9)} p95=${q(0.95)} p99=${q(0.99)} p99.9=${q(0.999)} max=${maxRaw.toFixed(3)}`)
console.log('')
console.log('现有曲线（hi=0.92, 指数 0.62）下的热度分布：')
for (const [k] of BANDS) {
  const n = bandCount[k]
  console.log(`  ${k.padEnd(6)} ${String(n).padStart(6)} 对  ${((n / pairs) * 100).toFixed(2)}%`)
}
console.log('')
console.log('每个目标词"最像的那个非答案词"有多像（这是玩家能爬到的天花板）：')
perTargetTop.sort((a, b) => b.best - a.best)
for (const r of perTargetTop.slice(0, 5)) console.log(`  ${r.t} ← ${r.bestW} raw=${r.best.toFixed(3)} base=${r.base.toFixed(3)}`)
console.log('  ...')
for (const r of perTargetTop.slice(-3)) console.log(`  ${r.t} ← ${r.bestW} raw=${r.best.toFixed(3)} base=${r.base.toFixed(3)}`)
const tops = perTargetTop.map((r) => r.best)
tops.sort((a, b) => a - b)
console.log(`  天花板中位数 ${tops[Math.floor(tops.length / 2)].toFixed(3)}，最低 ${tops[0].toFixed(3)}，最高 ${tops[tops.length - 1].toFixed(3)}`)

// 用"实测天花板"重新定 hi，看分布会不会摊开
function score2(raw, base, ov, hi) {
  const boosted = Math.min(0.95, raw + 0.1 * ov)
  const coldTop = base + 0.09
  if (boosted <= coldTop) {
    const x = Math.min(1, Math.max(0, (boosted - (base - 0.13)) / 0.22))
    return Math.round(8 * x)
  }
  const x = Math.min(1, Math.max(0, (boosted - coldTop) / (hi - coldTop)))
  return Math.round(8 + 92 * Math.pow(x, 0.62))
}

const HI2 = 0.72
const band2 = Object.fromEntries(BANDS.map(([k]) => [k, 0]))
for (const t of words) {
  const tv = vecs.get(t)
  const base = await baseline(tv)
  for (const g of words) {
    if (g === t) continue
    const pct = Math.min(99, score2(cos(tv, vecs.get(g)), base, overlap(t, g), HI2))
    for (const [k, f] of BANDS) if (f(pct)) band2[k]++
  }
}
console.log('')
console.log(`换成 hi=${HI2} 的曲线后：`)
for (const [k] of BANDS) {
  const n = band2[k]
  console.log(`  ${k.padEnd(6)} ${String(n).padStart(6)} 对  ${((n / pairs) * 100).toFixed(2)}%`)
}
