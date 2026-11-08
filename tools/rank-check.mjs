import { WORD_POOL } from './server/words.js'

const BASE = 'http://127.0.0.1:3110'
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json()

// 选 12 个目标：每个类别取一个
const byCat = {}
for (const x of WORD_POOL) (byCat[x.c] ||= []).push(x)
const targets = Object.keys(byCat).slice(0, 14).map((c) => byCat[c][Math.floor(Math.random() * byCat[c].length)])

for (const t of targets) {
  const g = await post('/api/game')
  // 强制注入目标? 只统计：把全池都猜一遍，看答案排名
  const rows = []
  for (const x of WORD_POOL) {
    const r = await post('/api/guess', { id: g.id, word: x.w })
    if (r.error) { await new Promise((r2) => setTimeout(r2, 1200)); continue }
    rows.push({ w: x.w, pct: r.pct, exact: r.exact })
    if (r.exact) break
  }
  rows.sort((a, b) => b.pct - a.pct)
  const ans = rows.find((r) => r.exact)
  const rank = rows.findIndex((r) => r.exact) + 1
  console.log(`[${g.category}] 答案=${ans?.w} 排名=${rank}/${rows.length}  次优: ${rows.filter(r => !r.exact).slice(0, 4).map((r) => `${r.w}${r.pct}%`).join(' ')}`)
}
