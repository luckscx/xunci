import express from 'express'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { init, isReady, embedWord, baseline, overlap, score } from './embedder.js'
import { pickTarget } from './words.js'

const PORT = process.env.PORT || 3110
const HOST = process.env.HOST || '0.0.0.0'
const ATTEMPTS = 30
// 分类提示要猜满这么多次才给：开局就知道分类等于把答案缩到十来个词里
const CATEGORY_AT = 10
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const app = express()
app.use(express.json({ limit: '16kb' }))
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

/** 会话：单进程内存即可，进程重启后玩家重开一局 */
const games = new Map()
const baseCache = new Map()

const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[，。！？,.!?]/g, '').trim()

function cleanup() {
  const now = Date.now()
  for (const [id, g] of games) {
    if (now - g.created > 3 * 3600_000 || g.guesses.length > 500) games.delete(id)
  }
}
setInterval(cleanup, 600_000).unref()

// 简单限流，防刷
const hits = new Map()
function limited(ip) {
  const now = Date.now()
  const rec = hits.get(ip) || { t: now, n: 0 }
  if (now - rec.t > 60_000) {
    rec.t = now
    rec.n = 0
  }
  rec.n++
  hits.set(ip, rec)
  return rec.n > 400
}

async function targetBaseline(word) {
  if (baseCache.has(word)) return baseCache.get(word)
  const v = await embedWord(word)
  const b = await baseline(v)
  baseCache.set(word, b)
  return b
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ready: isReady(), games: games.size })
})

app.post('/api/game', async (req, res) => {
  if (!isReady()) return res.status(503).json({ error: '模型正在加载，请稍候' })
  const t = pickTarget()
  const id = randomUUID()
  const base = await targetBaseline(t.w)
  games.set(id, {
    id,
    word: t.w,
    category: t.c,
    difficulty: t.d,
    base,
    created: Date.now(),
    guesses: [],
    finished: false,
  })
  res.json({
    id,
    difficulty: t.d,
    attempts: ATTEMPTS,
    categoryAt: CATEGORY_AT,
    // 分类刻意不在开局下发：否则开局就等于把答案缩到十来个词里
    // 仅本地 QA 用：CIWEN_DEV_HINT=1 时返回答案，生产环境不设该变量
    ...(process.env.CIWEN_DEV_HINT === '1' ? { answer: t.w } : {}),
  })
})

app.post('/api/guess', async (req, res) => {
  const { id } = req.body || {}
  const word = norm(req.body?.word).slice(0, 12)
  if (!word) return res.status(400).json({ error: '请输入一个词' })
  if (!/[\u4e00-\u9fa5]/.test(word)) return res.status(400).json({ error: '请用中文词语来猜' })
  const g = games.get(id)
  if (!g) return res.status(404).json({ error: '这一局已经过期了，重开一局吧' })
  if (g.finished) return res.status(400).json({ error: '这一局已经结束了' })
  if (limited(req.ip)) return res.status(429).json({ error: '猜得太快了，歇一下' })

  const dup = g.guesses.find((x) => x.word === word)
  if (dup) {
    return res.json({
      pct: dup.pct,
      exact: false,
      dup: true,
      attemptsLeft: ATTEMPTS - g.guesses.length,
      best: bestOf(g),
      prev: g.guesses.length > 1 ? g.guesses[g.guesses.length - 2].pct : null,
      category: g.guesses.length >= CATEGORY_AT ? g.category : null,
    })
  }

  const tv = await embedWord(g.word)
  const gv = await embedWord(word)
  const raw = cos(tv, gv)
  const exact = word === g.word
  // 非精确命中最多 99 热度：像「从容」对「从从容容」这种极近词，避免显示 100 却不判胜
  const pct = exact ? 100 : Math.min(99, score(raw, g.base, overlap(g.word, word)))
  const prev = g.guesses.length ? g.guesses[g.guesses.length - 1].pct : null
  g.guesses.push({ word, pct, at: Date.now() })
  if (exact) g.finished = true

  res.json({
    pct,
    exact,
    rank: rankOf(g, pct),
    attemptsLeft: ATTEMPTS - g.guesses.length,
    best: bestOf(g),
    prev,
    // 分类提示：猜满 CATEGORY_AT 次才下发，之前的响应里根本不带这个字段
    category: g.guesses.length >= CATEGORY_AT ? g.category : null,
    // 猜满一半后放出字数提示，给僵持的局一点抓手
    hint: !exact && g.guesses.length >= 15 ? { chars: g.word.length } : null,
    answer: exact || g.guesses.length >= ATTEMPTS ? g.word : undefined,
  })
})

app.post('/api/reveal', (req, res) => {
  const g = games.get(req.body?.id)
  if (!g) return res.status(404).json({ error: '这一局已经过期了' })
  g.finished = true
  res.json({ answer: g.word, guesses: g.guesses.length })
})

function bestOf(g) {
  if (!g.guesses.length) return null
  return g.guesses.reduce((a, b) => (b.pct > a.pct ? b : a))
}
function rankOf(g, pct) {
  return g.guesses.filter((x) => x.pct > pct).length + 1
}

// 静态前端（构建产物）——生产单端口即可，本地预览也走这里
const distDir = join(ROOT, 'dist')
app.use(express.static(distDir, { index: 'index.html', maxAge: '7d', setHeaders: (res, p) => {
  if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
} }))
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(join(distDir, 'index.html')))

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: '服务器打了个喷嚏，再试一次' })
})

init()
  .then(() => {
    app.listen(PORT, HOST, () => console.log(`[ciwen] listening on ${HOST}:${PORT}, model ready`))
  })
  .catch((e) => {
    console.error('model init failed', e)
    process.exit(1)
  })
