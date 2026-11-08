// 关键统计：每个目标词，词池里到底有几个词能蹭到 36 热度以上（即"有意义的反馈"）
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

const stats = []
for (const t of words) {
  const tv = vecs.get(t)
  const base = await baseline(tv)
  let ge9 = 0, ge21 = 0, ge36 = 0, ge51 = 0, ge66 = 0
  for (const g of words) {
    if (g === t) continue
    const p = Math.min(99, score(cos(tv, vecs.get(g)), base, overlap(t, g)))
    if (p > 8) ge9++
    if (p > 20) ge21++
    if (p > 35) ge36++
    if (p > 50) ge51++
    if (p > 65) ge66++
  }
  stats.push({ t, ge9, ge21, ge36, ge51, ge66 })
}

const avg = (k) => (stats.reduce((s, r) => s + r[k], 0) / stats.length).toFixed(1)
console.log(`223 个目标词的平均情况（分母 222 个候选词）：`)
console.log(`  热度 > 8   （不是无关）: ${avg('ge9')} 个词`)
console.log(`  热度 > 20  （远亲）    : ${avg('ge21')} 个词`)
console.log(`  热度 > 35  （蹭到边）  : ${avg('ge36')} 个词`)
console.log(`  热度 > 50  （方向对了）: ${avg('ge51')} 个词`)
console.log(`  热度 > 65  （很烫）    : ${avg('ge66')} 个词`)
console.log('')
const zero = stats.filter((r) => r.ge36 === 0)
console.log(`有 ${zero.length} 个目标词（${((zero.length / stats.length) * 100).toFixed(0)}%）在词池里连一个 36 热度以上的词都没有`)
console.log('例子:', zero.slice(0, 8).map((r) => r.t).join(' '))
const dist = {}
for (const r of stats) dist[r.ge36] = (dist[r.ge36] || 0) + 1
console.log('分布（≥36 热度的词数 → 目标词个数）:', JSON.stringify(dist))
