// 对照：同一串猜测，旧"相似度百分比" vs 新"词池排名百分位"
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

for (const target of ['篮球', '钢琴', '火锅', '医院']) {
  if (!vecs.has(target)) { console.log(`(${target} 不在池里，跳过)`); continue }
  const tv = vecs.get(target)
  const base = await baseline(tv)
  const rows = []
  for (const g of words) {
    if (g === target) continue
    const raw = cos(tv, vecs.get(g))
    rows.push({ g, raw, pct: Math.min(99, score(raw, base, overlap(target, g))) })
  }
  rows.sort((a, b) => b.raw - a.raw)
  const n = rows.length
  console.log(`\n=== 目标：${target}（池内其他词 ${n} 个）===`)
  console.log('排名  词        旧热度  新百分位  旧热度相邻重复度')
  rows.slice(0, 8).forEach((r, i) => {
    const pctile = Math.round((1 - i / n) * 100)
    const dupHeat = rows.slice(0, i + 1).filter((x) => x.pct === r.pct).length
    console.log(
      `${String(i + 1).padStart(4)}  ${r.g.padEnd(6, '　')}  ${String(r.pct).padStart(4)}    ${String(pctile).padStart(5)}      ${dupHeat > 1 ? `与前面 ${dupHeat - 1} 个同分` : ''}`,
    )
  })
  // 旧热度在整个池子里的重复情况
  const uniq = new Set(rows.map((r) => r.pct)).size
  console.log(`  → ${n} 个词只产生 ${uniq} 个不同热度值；最高非答案热度 ${rows[0].pct}，答案 100（中间空 ${100 - rows[0].pct}）`)
}
