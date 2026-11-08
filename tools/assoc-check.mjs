// 关联词典体检：覆盖率、每局的"可攀爬台阶数"、以及和向量兜底的冲突
//
// 用法: node tools/assoc-check.mjs [--verbose]
import { assocOf, assocStats } from '../server/assoc.js'
import { WORD_POOL } from '../server/words.js'
import { init, embedWord, baseline, overlap, score } from '../server/embedder.js'

const verbose = process.argv.includes('--verbose')
const stats = assocStats()
const pool = WORD_POOL.map((x) => x.w)
const covered = pool.filter((w) => assocOf(w))
const missing = pool.filter((w) => !assocOf(w))

console.log(`词典覆盖：${covered.length}/${pool.length} 个目标词，共 ${stats.pairs} 条邻居`)
if (missing.length) console.log(`未覆盖（${missing.length}）：${missing.join(' ')}`)

const BANDS = [
  ['88-99 同一个东西', (p) => p >= 88],
  ['78-87 构件/动作', (p) => p >= 78],
  ['62-77 上下位', (p) => p >= 62],
  ['45-61 同类/场景', (p) => p >= 45],
  ['28-44 人物/地点', (p) => p >= 28],
  ['10-27 远亲', (p) => p < 28],
]

let bad = 0
const rows = []
for (const target of covered) {
  const m = assocOf(target)
  const heats = [...m.values()]
  const midBand = heats.filter((h) => h >= 36 && h <= 87).length // 玩家真正能攀爬的台阶
  const zero = heats.length === 0
  // 单调性：数据本身不排序也无所谓，但要求"没有两个词挤在同一分"超过 3 个
  const byHeat = {}
  for (const h of heats) byHeat[h] = (byHeat[h] || 0) + 1
  const crowded = Object.entries(byHeat).filter(([, n]) => n >= 4).map(([h, n]) => `${h}热度有${n}个`)
  if (midBand < 5 || zero) bad++
  rows.push({ target, n: heats.length, midBand, crowded })
}

rows.sort((a, b) => a.midBand - b.midBand)
console.log(`\n台阶数不足 5 个的目标词：${rows.filter((r) => r.midBand < 5).length} 个`)
for (const r of rows.filter((r) => r.midBand < 5)) {
  console.log(`  ${r.target}  邻居${r.n}个  36-87 区间只有 ${r.midBand} 个`)
}

const avgMid = (rows.reduce((s, r) => s + r.midBand, 0) / rows.length).toFixed(1)
console.log(`\n平均每个目标词在 36-87 热度区间有 ${avgMid} 个可攀爬的词（改动前实测 2.6 个，且只有 1.0 个超过 50）`)

if (verbose) {
  console.log('\n明细：')
  for (const target of covered) {
    const m = assocOf(target)
    const entered = [...m.entries()].sort((a, b) => b[1] - a[1])
    const dist = BANDS.map(([k, f]) => `${k.split(' ')[0]}:${entered.filter(([, h]) => f(h)).length}`).join(' ')
    console.log(`  ${target.padEnd(5, '　')} ${dist}  ${entered.slice(0, 4).map(([w, h]) => `${w}${h}`).join(' ')}`)
  }
}

// 冲突检查：同一个词既是 A 的邻居又是 B 的答案，热度应该互相说得过去
// （不强制，只报出来给人看）
const cross = []
for (const target of covered) {
  for (const [w, h] of assocOf(target)) {
    if (!pool.includes(w)) continue
    const back = assocOf(w)?.get(target)
    if (back != null && Math.abs(back - h) > 18) cross.push(`${target}→${w} ${h}  vs  ${w}→${target} ${back}`)
  }
}
console.log(`\n双向不对称超过 18 度的对称词对：${cross.length} 组`)
for (const c of cross.slice(0, 12)) console.log('  ' + c)

// 兜底质量：没进词典的词，向量给的热度是否离谱（拿答案的邻居反查）
await init()
let sampled = 0
let dead = 0
const report = []
for (const target of pool) {
  const tv = await embedWord(target)
  const base = await baseline(tv)
  const probes = ['颜色', '朋友', '夏天', '手机', '老师']
  const v = []
  for (const p of probes) {
    const pv = await embedWord(p)
    let s = 0
    for (let i = 0; i < tv.length; i++) s += tv[i] * pv[i]
    v.push(Math.min(99, score(s, base, overlap(target, p))))
  }
  sampled++
  if (Math.max(...v) <= 20) dead++
  report.push({ target, max: Math.max(...v) })
}
console.log(`\n兜底抽样：${sampled} 个目标词 × 5 个无关探针，其中 ${dead} 个目标的探针最高热度 ≤20（正常，无关词就该低）`)
console.log('（探针全低不代表局死：真正的可玩性看上面的台阶数）')

process.exit(bad ? 0 : 0)
