import express from 'express'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { init, isReady, embedWord, baseline, overlap, score } from './embedder.js'
import { pickTarget, WORD_POOL } from './words.js'
import { assocOf, assocStats } from './assoc.js'
import { askJudge, judgeConfigured } from './judge.js'
import { loadState, touch, startPersist } from './store.js'
import { config, loadConfig, updateConfig } from './config.js'

const PORT = process.env.PORT || 3110
const HOST = process.env.HOST || '0.0.0.0'
// 管理页的隐藏入口，知道路径才能访问；前端页面上没有任何入口
const ADMIN_PATH = process.env.CIWEN_ADMIN_PATH || '/ciwen-manage-8f2k'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const app = express()
// 生产走 Nginx 反代：按 X-Forwarded-For 识别真实 IP，否则限流会让所有人共用一个桶
app.set('trust proxy', 1)
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
    // 分类提示：开启后猜满 categoryAt 次才随广播下发
    category: config.categoryHint && g.guesses.length >= config.categoryAt ? g.category : null,
    categoryAt: config.categoryHint ? config.categoryAt : null,
    difficulty: g.difficulty,
    attempts: config.attempts,
    startedAt: g.created,
    guesses: g.guesses,
    questions: g.questions ?? [],
    questionLimit: config.questions,
    allowReveal: config.allowReveal,
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

  const exact = word === g.word
  // 关联词典优先：作者分层的邻居直接给热度，补上模型对常识关联的盲区
  // （企鹅→南极 4、玫瑰→月季 7 这种情况）。表里没有的词才回落到向量算。
  const authored = exact ? null : assocOf(g.word)?.get(word)
  let pct
  if (exact) pct = 100
  else if (authored != null) pct = Math.min(99, authored)
  else {
    const tv = await embedWord(g.word)
    const gv = await embedWord(word)
    pct = Math.min(99, score(cos(tv, gv), g.base, overlap(g.word, word)))
  }
  g.guesses.push({ word, pct, by, byId, at: Date.now() })
  if (exact) {
    g.finished = true
    g.finishedAt = Date.now()
    g.endReason = 'guessed'
    g.winnerId = byId
  } else if (g.guesses.length >= config.attempts) {
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
  if (g.questions.length >= config.questions) return { full: true }
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
  res.json({ ok: true, ready: isReady(), games: games.size, players: players.size, assoc: assocStats().targets })
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
      attempts: config.attempts,
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
  const category = config.categoryHint && g.guesses.length >= config.categoryAt ? g.category : null
  if (r.dup) {
    return res.json({
      pct: r.pct,
      exact: false,
      dup: true,
      attemptsLeft: config.attempts - g.guesses.length,
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
    attemptsLeft: config.attempts - g.guesses.length,
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
    if (r.dup) return res.json({ yes: r.yes, dup: true, asked: g.questions.length, questionLimit: config.questions })
    if (!g.private && g.id === room.gameId) broadcastState()
    res.json({ yes: r.yes, dup: false, asked: g.questions.length, questionLimit: config.questions })
  } catch (e) {
    console.error('ask failed', e)
    res.status(502).json({ error: '判官走神了，再问一次' })
  }
})

app.post('/api/reveal', (req, res) => {
  const g = games.get(req.body?.id)
  if (!g) return res.status(404).json({ error: '这一局已经过期了' })
  if (g.finished) return res.json({ answer: g.word, guesses: g.guesses.length })
  if (!config.allowReveal) return res.status(403).json({ error: '管理员已关闭「放弃看答案」' })
  g.finished = true
  g.finishedAt = Date.now()
  g.endReason = 'revealed'
  touch()
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

// ---------- 管理页（隐藏入口，仅自己知道路径） ----------
const adminPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>寻词 · 管理</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #14121f; color: #eee;
    font: 15px/1.6 system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif;
    display: flex; justify-content: center; padding: 40px 16px; }
  main { width: 100%; max-width: 520px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #999; font-size: 13px; margin-bottom: 24px; }
  .card { background: #1e1b2e; border: 1px solid #33304a; border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; }
  .row + .row { border-top: 1px dashed #33304a; }
  label b { display: block; font-size: 14px; }
  label small { color: #999; font-size: 12px; }
  input[type=number] { width: 90px; padding: 6px 10px; border-radius: 8px; border: 1px solid #44405e;
    background: #14121f; color: #eee; font-size: 15px; text-align: center; }
  input[type=number]:disabled { opacity: .35; }
  .switch { position: relative; width: 46px; height: 26px; flex: none; }
  .switch input { opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .switch i { position: absolute; inset: 0; border-radius: 13px; background: #44405e; transition: .15s; pointer-events: none; }
  .switch i::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px;
    border-radius: 50%; background: #fff; transition: .15s; }
  .switch input:checked + i { background: #e8722f; }
  .switch input:checked + i::after { transform: translateX(20px); }
  button { width: 100%; padding: 11px; border: 0; border-radius: 10px; background: #e8722f;
    color: #fff; font-size: 15px; cursor: pointer; }
  button:disabled { opacity: .5; }
  .msg { text-align: center; font-size: 13px; min-height: 20px; margin-top: 10px; }
  .msg.ok { color: #7ec97e; } .msg.bad { color: #e07a7a; }
</style>
</head>
<body>
<main>
  <h1>寻词 · 全局管理</h1>
  <div class="sub">改动立即生效并向所有在线玩家广播，无需重启</div>
  <div class="card">
    <div class="row">
      <label><b>猜词次数上限</b><small>向量近似度猜词，每局可用次数</small></label>
      <input type="number" id="attempts" min="1" max="200" />
    </div>
    <div class="row">
      <label><b>问一问次数上限</b><small>每局是非题额度（0 = 禁用提问）</small></label>
      <input type="number" id="questions" min="0" max="50" />
    </div>
  </div>
  <div class="card">
    <div class="row">
      <label><b>允许「放弃，看答案」</b><small>关闭后前端按钮隐藏，接口也会拒绝</small></label>
      <span class="switch"><input type="checkbox" id="allowReveal" /><i></i></span>
    </div>
    <div class="row">
      <label><b>分类提示</b><small>关闭后整局不提示分类</small></label>
      <span class="switch"><input type="checkbox" id="categoryHint" /><i></i></span>
    </div>
    <div class="row">
      <label><b>猜几次后提示分类</b><small>分类提示开启时生效</small></label>
      <input type="number" id="categoryAt" min="0" max="200" />
    </div>
  </div>
  <button id="save">保存</button>
  <div class="msg" id="msg"></div>
</main>
<script>
const $ = (id) => document.getElementById(id)
async function loadCfg() {
  const r = await fetch(location.pathname + '/api/config')
  const c = await r.json()
  $('attempts').value = c.attempts
  $('questions').value = c.questions
  $('categoryAt').value = c.categoryAt
  $('allowReveal').checked = c.allowReveal
  $('categoryHint').checked = c.categoryHint
  $('categoryAt').disabled = $('categoryHint').checked ? false : true
}
$('categoryHint').addEventListener('change', (e) => { $('categoryAt').disabled = !e.target.checked })
$('save').addEventListener('click', async () => {
  const btn = $('save'); const msg = $('msg')
  btn.disabled = true; msg.textContent = ''; msg.className = 'msg'
  try {
    const r = await fetch(location.pathname + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attempts: +$('attempts').value,
        questions: +$('questions').value,
        categoryAt: +$('categoryAt').value,
        allowReveal: $('allowReveal').checked,
        categoryHint: $('categoryHint').checked,
      }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || '保存失败')
    $('attempts').value = d.attempts; $('questions').value = d.questions
    $('categoryAt').value = d.categoryAt
    msg.textContent = '已保存并生效'; msg.className = 'msg ok'
  } catch (e) { msg.textContent = e.message; msg.className = 'msg bad' }
  btn.disabled = false
})
loadCfg()
</script>
</body>
</html>`

app.get(ADMIN_PATH, (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.type('html').send(adminPage)
})

app.get(`${ADMIN_PATH}/api/config`, (req, res) => res.json(config))

app.post(`${ADMIN_PATH}/api/config`, (req, res) => {
  const r = updateConfig(req.body)
  if (!r.ok) return res.status(400).json({ error: r.error })
  broadcastState() // 配置变更实时下发所有在线玩家
  res.json(config)
})

// ---------- WebSocket ----------
wss.on('connection', (ws, req) => {
  // 生产经 Nginx 反代，同样取转发头里的真实 IP，避免 WebSocket 限流误伤
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'
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
            if (r.full) return sendNotice(ws, 'error', `这局只有 ${config.questions} 个问题，省着点问`)
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
        if (!config.allowReveal) return sendNotice(ws, 'error', '管理员已关闭「放弃看答案」')
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
loadConfig()

init()
  .then(() => {
    // 新增目标词时容易忘配关联词典：这些局的反馈只能靠向量兜底，
    // 对企鹅/玫瑰这类常识关联，向量几乎是瞎的，所以启动时就提醒。
    const missing = WORD_POOL.filter((x) => !assocOf(x.w)).map((x) => x.w)
    if (missing.length) {
      console.warn(`[ciwen] ${missing.length} 个目标词没有关联词典：${missing.slice(0, 12).join(' ')}${missing.length > 12 ? ' …' : ''}`)
    }
    server.listen(PORT, HOST, () => {
      console.log(`[ciwen] listening on ${HOST}:${PORT}, model ready, assoc ${assocStats().targets} 词 / ${assocStats().pairs} 条`)
      // 建局在玩家连入后按需触发；这里只广播一次 ready 状态
      broadcastState()
    })
  })
  .catch((e) => {
    console.error('model init failed', e)
    process.exit(1)
  })
