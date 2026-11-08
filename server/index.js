import express from 'express'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { init, isReady, embedWord, baseline, overlap, score } from './embedder.js'
import { pickTarget } from './words.js'
import { askJudge, judgeConfigured } from './judge.js'
import { loadState, touch, startPersist } from './store.js'

const PORT = process.env.PORT || 3110
const HOST = process.env.HOST || '0.0.0.0'
const ATTEMPTS = 30
const QUESTIONS = 10 // 每局是非题额度，和猜词次数分开算
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

app.use(express.json({ limit: '16kb' }))
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

/** 局：单进程内存即可，进程重启后大家重开一局 */
const games = new Map()
const baseCache = new Map()

/** 公共房间：所有客户端共享的当前局，进度通过 /ws 广播同步 */
const room = { gameId: null }
/** 在线玩家：ws -> { id, name, ip } */
const players = new Map()

// 启动时恢复上次落盘的对局，服务重启不再作废进行中的局
const saved = loadState()
if (saved) {
  for (const g of saved.games) games.set(g.id, g)
  if (saved.room?.gameId && games.has(saved.room.gameId)) room.gameId = saved.room.gameId
  console.log(`[ciwen] restored ${saved.games.length} game(s) from disk`)
}

/** 当前需要落盘的完整状态（players 是连接态，不持久化） */
function persistState() {
  return { room: { gameId: room.gameId }, games: [...games.values()] }
}

const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[，。！？,.!?]/g, '').trim()
/** 是非题保留标点（问句要通顺），只折叠空白 */
const normQ = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40)

function cleanup() {
  const now = Date.now()
  let removed = false
  for (const [id, g] of games) {
    if (id === room.gameId) continue
    if (now - g.created > 3 * 3600_000 || g.guesses.length > 500) {
      games.delete(id)
      removed = true
    }
  }
  if (removed) touch()
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

// ---------- 匿名昵称 ----------
const ADJ = ['路过的', '好奇的', '刚睡醒的', '摸鱼的', '慢半拍的', '偷偷卷的', '爱凑热闹的', '不爱说话的', '迷路的', '打瞌睡的']
const ANIMAL = ['橘猫', '水獭', '小熊猫', '刺猬', '企鹅', '柴犬', '仓鼠', '章鱼', '浣熊', '羊驼']
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const randomName = () => `${pick(ADJ)}${pick(ANIMAL)}`

function sanitizeName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 12)
  return s || randomName()
}

// ---------- 状态广播 ----------
function publicGame(g) {
  return {
    id: g.id,
    // 分类提示：猜满 CATEGORY_AT 次才随广播下发
    category: g.guesses.length >= CATEGORY_AT ? g.category : null,
    categoryAt: CATEGORY_AT,
    difficulty: g.difficulty,
    attempts: ATTEMPTS,
    startedAt: g.created,
    guesses: g.guesses,
    questions: g.questions ?? [],
    questionLimit: QUESTIONS,
    finished: g.finished,
    endedAt: g.finishedAt ?? null,
    endReason: g.endReason ?? null,
    winnerId: g.winnerId ?? null,
    // 仅本地 QA 用：CIWEN_DEV_HINT=1 时提前返回答案，生产环境不设该变量
    answer: g.finished || process.env.CIWEN_DEV_HINT === '1' ? g.word : undefined,
    hint: !g.finished && g.guesses.length >= 15 ? { chars: g.word.length } : null,
  }
}

function roomState() {
  const g = room.gameId ? games.get(room.gameId) : null
  return {
    type: 'state',
    now: Date.now(),
    ready: isReady(),
    game: g ? publicGame(g) : null,
    players: [...players.values()].map((p) => ({ id: p.id, name: p.name })),
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}
const sendNotice = (ws, kind, message) => sendTo(ws, { type: 'notice', kind, message })

function broadcastState() {
  const snap = roomState()
  for (const [ws] of players) sendTo(ws, snap)
}

// ---------- 建局 ----------
function newGameData(t, base, priv) {
  const g = {
    id: randomUUID(),
    word: t.w,
    category: t.c,
    difficulty: t.d,
    base,
    created: Date.now(),
    guesses: [],
    questions: [],
    finished: false,
    finishedAt: null,
    endReason: null,
    winnerId: null,
    private: priv,
  }
  games.set(g.id, g)
  touch()
  return g
}

// 房间建局串行化：同时多人点"换一个词"也只按顺序落地
let creating = Promise.resolve()
function createRoomGame() {
  const task = creating
    .catch(() => {})
    .then(async () => {
      if (!isReady()) return null
      const t = pickTarget()
      const base = await targetBaseline(t.w)
      const g = newGameData(t, base, false)
      room.gameId = g.id
      touch()
      broadcastState()
      return g
    })
    .catch((e) => {
      console.error('createRoomGame failed', e)
      return null
    })
  creating = task
  return task
}

// ---------- 猜词 ----------
async function doGuess(g, word, by, byId) {
  const dup = g.guesses.find((x) => x.word === word)
  if (dup) return { dup: true, pct: dup.pct }

  const tv = await embedWord(g.word)
  const gv = await embedWord(word)
  const raw = cos(tv, gv)
  const exact = word === g.word
  // 非精确命中最多 99 热度：像「从容」对「从从容容」这种极近词，避免显示 100 却不判胜
  const pct = exact ? 100 : Math.min(99, score(raw, g.base, overlap(g.word, word)))
  g.guesses.push({ word, pct, by, byId, at: Date.now() })
  if (exact) {
    g.finished = true
    g.finishedAt = Date.now()
    g.endReason = 'guessed'
    g.winnerId = byId
  } else if (g.guesses.length >= ATTEMPTS) {
    g.finished = true
    g.finishedAt = Date.now()
    g.endReason = 'exhausted'
  }
  touch()
  return { dup: false, pct, exact }
}

// ---------- 是非题 ----------
async function doAsk(g, q, by, byId) {
  const dup = g.questions.find((x) => x.q === q)
  if (dup) return { dup: true, yes: dup.yes }
  if (g.questions.length >= QUESTIONS) return { full: true }
  // 判官站在答案立场回答，返回"是"的概率 0-100
  const yes = await askJudge(q, g.word, g.category)
  g.questions.push({ q, yes, by, byId, at: Date.now() })
  touch()
  return { dup: false, yes }
}

/** 是非题入参校验，通过返回归一化问句，否则返回错误文案 */
function checkAsk(raw) {
  const q = normQ(raw)
  if (q.length < 2) return { error: '问题太短了，比如「它是吃的吗？」' }
  if (!/[\u4e00-\u9fa5]/.test(q)) return { error: '请用中文提问' }
  if (!/[吗呢么?？]$/.test(q)) return { error: '请问一个是非题（以「吗/呢/?」结尾）' }
  if (!judgeConfigured()) return { error: '是非题判官还没配置（需要 TYPESAFE_API_KEY）' }
  return { q }
}

// ---------- REST ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ready: isReady(), games: games.size, players: players.size })
})

app.get('/api/state', (req, res) => {
  res.json(roomState())
})

// 公共房间开局/换词；?private=1 保留旧私有局（tools/ 离线脚本用，不进入房间）
app.post('/api/game', async (req, res) => {
  if (!isReady()) return res.status(503).json({ error: '模型正在加载，请稍候' })
  if (req.query.private === '1') {
    const t = pickTarget()
    const base = await targetBaseline(t.w)
    const g = newGameData(t, base, true)
    return res.json({
      id: g.id,
      category: g.category,
      difficulty: g.difficulty,
      attempts: ATTEMPTS,
      ...(process.env.CIWEN_DEV_HINT === '1' ? { answer: g.word } : {}),
    })
  }
  const g = await createRoomGame()
  if (!g) return res.status(503).json({ error: '模型正在加载，请稍候' })
  res.json(publicGame(g))
})

app.post('/api/guess', async (req, res) => {
  const g = games.get(req.body?.id)
  if (!g) return res.status(404).json({ error: '这一局已经过期了，重开一局吧' })
  const word = norm(req.body?.word).slice(0, 12)
  if (!word) return res.status(400).json({ error: '请输入一个词' })
  if (!/[\u4e00-\u9fa5]/.test(word)) return res.status(400).json({ error: '请用中文词语来猜' })
  if (g.finished) return res.status(400).json({ error: '这一局已经结束了' })
  if (limited(req.ip)) return res.status(429).json({ error: '猜得太快了，歇一下' })

  const r = await doGuess(g, word, 'API', null)
  const category = g.guesses.length >= CATEGORY_AT ? g.category : null
  if (r.dup) {
    return res.json({
      pct: r.pct,
      exact: false,
      dup: true,
      attemptsLeft: ATTEMPTS - g.guesses.length,
      best: bestOf(g),
      prev: g.guesses.length > 1 ? g.guesses[g.guesses.length - 2].pct : null,
      category,
    })
  }
  if (!g.private && g.id === room.gameId) broadcastState()
  res.json({
    pct: r.pct,
    exact: r.exact,
    rank: rankOf(g, r.pct),
    attemptsLeft: ATTEMPTS - g.guesses.length,
    best: bestOf(g),
    prev: g.guesses.length > 1 ? g.guesses[g.guesses.length - 2].pct : null,
    answer: g.finished ? g.word : undefined,
  })
})

app.post('/api/ask', async (req, res) => {
  const g = games.get(req.body?.id)
  if (!g) return res.status(404).json({ error: '这一局已经过期了，重开一局吧' })
  const v = checkAsk(req.body?.q)
  if (v.error) return res.status(400).json({ error: v.error })
  if (g.finished) return res.status(400).json({ error: '这一局已经结束了' })
  if (limited(req.ip)) return res.status(429).json({ error: '问得太快了，歇一下' })

  try {
    const r = await doAsk(g, v.q, 'API', null)
    if (r.dup) return res.json({ yes: r.yes, dup: true, asked: g.questions.length, questionLimit: QUESTIONS })
    if (!g.private && g.id === room.gameId) broadcastState()
    res.json({ yes: r.yes, dup: false, asked: g.questions.length, questionLimit: QUESTIONS })
  } catch (e) {
    console.error('ask failed', e)
    res.status(502).json({ error: '判官走神了，再问一次' })
  }
})

app.post('/api/reveal', (req, res) => {
  const g = games.get(req.body?.id)
  if (!g) return res.status(404).json({ error: '这一局已经过期了' })
  if (!g.finished) {
    g.finished = true
    g.finishedAt = Date.now()
    g.endReason = 'revealed'
    touch()
  }
  if (!g.private && g.id === room.gameId) broadcastState()
  res.json({ answer: g.word, guesses: g.guesses.length })
})

function bestOf(g) {
  if (!g.guesses.length) return null
  return g.guesses.reduce((a, b) => (b.pct > a.pct ? b : a))
}
function rankOf(g, pct) {
  return g.guesses.filter((x) => x.pct > pct).length + 1
}

// ---------- WebSocket ----------
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || '?'
  ws.isAlive = true
  ws.on('pong', () => (ws.isAlive = true))

  ws.on('message', (raw) => {
    if (raw.length > 4096) return
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    const me = players.get(ws)

    switch (msg.type) {
      case 'hello': {
        const id = typeof msg.id === 'string' && msg.id.length <= 64 ? msg.id : randomUUID()
        players.set(ws, { id, name: sanitizeName(msg.name), ip })
        sendTo(ws, roomState())
        // 服务器刚启动还没有局时，第一个进来的玩家触发建局
        if (!room.gameId || !games.get(room.gameId)) void createRoomGame()
        else broadcastState() // 在线名单变化，同步给所有人
        break
      }
      case 'rename': {
        if (!me) break
        me.name = sanitizeName(msg.name)
        broadcastState()
        break
      }
      case 'guess': {
        if (!me) break
        const g = games.get(room.gameId)
        if (!g) return sendNotice(ws, 'error', '还没有进行中的局')
        if (g.finished) return sendNotice(ws, 'error', '这一局已经结束了')
        if (limited(ip)) return sendNotice(ws, 'error', '猜得太快了，歇一下')
        const word = norm(msg.word).slice(0, 12)
        if (!word) return sendNotice(ws, 'error', '请输入一个词')
        if (!/[\u4e00-\u9fa5]/.test(word)) return sendNotice(ws, 'error', '请用中文词语来猜')
        doGuess(g, word, me.name, me.id)
          .then((r) => {
            if (r.dup) return sendNotice(ws, 'dup', `「${word}」猜过了，换一个`)
            broadcastState()
          })
          .catch((e) => {
            console.error('guess failed', e)
            sendNotice(ws, 'error', '服务器打了个喷嚏，再试一次')
          })
        break
      }
      case 'ask': {
        if (!me) break
        const g = games.get(room.gameId)
        if (!g) return sendNotice(ws, 'error', '还没有进行中的局')
        const v = checkAsk(msg.q)
        if (v.error) return sendNotice(ws, 'error', v.error)
        if (g.finished) return sendNotice(ws, 'error', '这一局已经结束了')
        if (limited(ip)) return sendNotice(ws, 'error', '问得太快了，歇一下')
        doAsk(g, v.q, me.name, me.id)
          .then((r) => {
            if (r.full) return sendNotice(ws, 'error', `这局只有 ${QUESTIONS} 个问题，省着点问`)
            if (r.dup) return sendNotice(ws, 'dup', '这个问题问过了')
            broadcastState()
          })
          .catch((e) => {
            console.error('ask failed', e)
            sendNotice(ws, 'error', '判官走神了，再问一次')
          })
        break
      }
      case 'new': {
        if (!isReady()) return sendNotice(ws, 'error', '模型正在加载，请稍候')
        void createRoomGame()
        break
      }
      case 'reveal': {
        const g = games.get(room.gameId)
        if (g && !g.finished) {
          g.finished = true
          g.finishedAt = Date.now()
          g.endReason = 'revealed'
          touch()
          broadcastState()
        }
        break
      }
    }
  })

  ws.on('close', () => {
    players.delete(ws)
    broadcastState()
  })
})

// 掐掉断线未关的连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 30_000).unref()

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

startPersist(persistState)

init()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[ciwen] listening on ${HOST}:${PORT}, model ready`)
      // 建局在玩家连入后按需触发；这里只广播一次 ready 状态
      broadcastState()
    })
  })
  .catch((e) => {
    console.error('model init failed', e)
    process.exit(1)
  })
