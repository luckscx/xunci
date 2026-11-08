// 闯关模式：玩家先挑一个擅长的领域 → 依次猜该领域的 4 个词 → 按「次数 + 用时」上领域榜。
// 与公共房间完全隔离：独立的私有会话走 REST，不写 room.gameId、不广播 /ws，
// 所以别人的闯关进度不会干扰房间对局，房间对局也不会消耗闯关的次数和时限。
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isReady } from './embedder.js'
import { WORD_POOL } from './words.js'
import { rateGuess, targetBaseline } from './scoring.js'
import { askJudge, judgeConfigured, checkAsk } from './judge.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'data', 'challenge.json')
const MAX_PLAYERS = 100

/** 规则集中放这里，前端从 /categories 读，不写死 */
export const RULES = {
  levels: 4,
  timeLimitMs: 6 * 60_000,
  /** 主玩法问一问的整轮额度（4 题共享），判官未配置时为 0 */
  questionLimit: 10,
  /** 猜词额度（4 题共享），问不消耗猜词次数 */
  guessLimit: 30,
  /** 综合分：一步（问或猜）折算 30 秒，于是「步数 + 时间」变成同一个量纲，越低越好 */
  perGuessSeconds: 30,
  /** 每题猜几次后给字数提示 */
  hintAfter: 3,
}

/**
 * 24 个细分分类太碎，选领域时按语义聚合成 8 个领域。
 * 只影响闯关模式；房间对局的分类提示仍用 words.js 里的细分类。
 */
export const DOMAINS = [
  { name: '吃喝日常', groups: ['食物', '饮品', '衣物', '家居'] },
  { name: '自然万物', groups: ['动物', '植物', '自然', '天气', '身体'] },
  { name: '人间百态', groups: ['地点', '职业', '商业', '节日'] },
  { name: '科技出行', groups: ['科技', '交通', '工具'] },
  { name: '文体娱乐', groups: ['运动', '音乐', '影视'] },
  { name: '脑洞抽象', groups: ['情绪', '抽象', '学科'] },
  { name: '历史', groups: ['历史'] },
  { name: '网络热梗', groups: ['热梗'] },
]

// 词库新增分类却忘了归组时直接启动失败，避免那批词永远抽不到
const SUB_CATEGORIES = [...new Set(WORD_POOL.map((x) => x.c))]
const GROUPED = DOMAINS.flatMap((d) => d.groups)
if (new Set(GROUPED).size !== GROUPED.length) throw new Error('challenge: 细分分类被归到了多个领域')
const ungrouped = SUB_CATEGORIES.filter((c) => !GROUPED.includes(c))
if (ungrouped.length) throw new Error(`challenge: 这些分类没有归入领域：${ungrouped.join(' ')}`)
const stale = GROUPED.filter((c) => !SUB_CATEGORIES.includes(c))
if (stale.length) throw new Error(`challenge: 领域里出现了词库不存在的分类：${stale.join(' ')}`)

export const DOMAIN_NAMES = DOMAINS.map((d) => d.name)
export const DOMAIN_VIEW = DOMAINS.map((d) => ({
  name: d.name,
  groups: d.groups,
  count: WORD_POOL.filter((x) => d.groups.includes(x.c)).length,
}))
const SUB_TO_DOMAIN = new Map(DOMAINS.flatMap((d) => d.groups.map((g) => [g, d.name])))
/** 兼容旧链接 / 旧前端传进来的细分分类名 */
const resolveDomain = (raw) => {
  const s = String(raw || '')
  return DOMAIN_NAMES.includes(s) ? s : SUB_TO_DOMAIN.get(s) || null
}

const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[，。！？,.!?]/g, '').trim()

/** 会话只在进程内存里；重启后未完成的挑战作废，已通关的榜单落盘保留 */
const sessions = new Map()
/** 聚合领域名 -> 每个玩家的历史最佳成绩 */
const boards = new Map()

function validEntry(e) {
  return (
    e && typeof e.playerId === 'string' && typeof e.name === 'string' &&
    ['used', 'seconds', 'score', 'at'].every((k) => Number.isFinite(e[k]))
  )
}

/** 同一玩家只留综合分更低的一次（榜单合并时也要去重） */
function upsert(list, entry) {
  const i = list.findIndex((e) => e.playerId === entry.playerId)
  if (i < 0) list.push(entry)
  else if (entry.score < list[i].score) list[i] = entry
}
const sortEntries = (list) => list.sort((a, b) => a.score - b.score || a.used - b.used || a.at - b.at)

function loadBoards() {
  let migrated = false
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    for (const [key, list] of Object.entries(raw?.boards ?? {})) {
      if (!Array.isArray(list)) continue
      const domain = resolveDomain(key)
      if (!domain) continue
      // 老榜单按 23 个细分分类存，合并进新领域，已打出来的成绩不丢
      if (key !== domain) migrated = true
      const target = boards.get(domain) || []
      for (const e of list) if (validEntry(e)) upsert(target, e)
      boards.set(domain, target)
    }
  } catch {
    /* 首次启动没有榜单文件 */
  }
  for (const [domain, list] of boards) boards.set(domain, sortEntries(list).slice(0, MAX_PLAYERS))
  if (migrated) persistBoards()
}

function persistBoards() {
  try {
    mkdirSync(join(ROOT, 'data'), { recursive: true })
    const tmp = FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify({ boards: Object.fromEntries(boards) }))
    renameSync(tmp, FILE)
  } catch (e) {
    console.error('challenge board persist failed', e)
  }
}
loadBoards()

const shuffle = (arr) => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 从领域下所有细分分类里抽 4 个词，尽量覆盖不同难度，再按易到难排成关卡曲线 */
function pickLevels(domainName) {
  const domain = DOMAINS.find((d) => d.name === domainName)
  const pool = WORD_POOL.filter((x) => domain.groups.includes(x.c))
  const picked = []
  for (const d of [1, 2, 3]) {
    const bucket = pool.filter((x) => x.d === d)
    if (bucket.length) picked.push(shuffle(bucket)[0])
  }
  const rest = shuffle(pool.filter((x) => !picked.includes(x)))
  while (picked.length < RULES.levels && rest.length) picked.push(rest.pop())
  return picked.sort((a, b) => a.d - b.d)
}

async function createSession(domain, playerId, name) {
  const picked = pickLevels(domain)
  const bases = await Promise.all(picked.map((t) => targetBaseline(t.w)))
  const startedAt = Date.now()
  const c = {
    id: randomUUID(),
    // 保留 category 字段名兼容前端契约，值现在是聚合后的领域名
    category: domain,
    playerId,
    name,
    startedAt,
    // 等基准算完才开始计时，模型冷启动不占用玩家的时间预算
    deadline: startedAt + RULES.timeLimitMs,
    levels: picked.map((t, i) => ({
      word: t.w, difficulty: t.d, base: bases[i], guesses: [], questions: [], cleared: false, clearedAt: null,
    })),
    index: 0,
    used: 0,
    finished: false,
    finishedAt: null,
    result: null,
    score: null,
    rank: null,
    busy: false,
  }
  sessions.set(c.id, c)
  return c
}

/** 记录通关成绩：同一玩家在同一领域只保留最好的一次，避免一个人刷满整张榜 */
function record(c, seconds, steps) {
  const list = boards.get(c.category) || []
  upsert(list, { playerId: c.playerId, name: c.name, used: steps, seconds, score: c.score, at: c.finishedAt })
  sortEntries(list)
  const rank = list.findIndex((e) => e.playerId === c.playerId) + 1
  boards.set(c.category, list.slice(0, MAX_PLAYERS))
  persistBoards()
  return rank
}

function finish(c, result) {
  if (c.finished) return
  // 超时后到达的请求不能把用时算超，统一截在 deadline
  const at = Math.min(Date.now(), c.deadline)
  c.finished = true
  c.finishedAt = at
  c.result = result
  if (result === 'cleared') {
    const seconds = Math.max(0, Math.round((at - c.startedAt) / 1000))
    // 问与猜都消耗玩家的时间预算（问还消耗判官成本），综合分按总步数计
    const steps = c.used + c.levels.reduce((s, l) => s + l.questions.length, 0)
    c.score = steps * RULES.perGuessSeconds + seconds
    c.rank = record(c, seconds, steps)
  }
}

function checkTimeout(c) {
  if (!c.finished && Date.now() >= c.deadline) finish(c, 'timeout')
}

/** 脱敏下发：未解锁的关卡不给答案，只在结束后全部揭晓 */
function publicState(c) {
  const now = Date.now()
  const cur = c.levels[Math.min(c.index, RULES.levels - 1)]
  return {
    id: c.id,
    category: c.category,
    name: c.name,
    playerId: c.playerId,
    total: RULES.levels,
    index: c.index,
    level: Math.min(c.index + 1, RULES.levels),
    levels: c.levels.map((l, i) => ({
      state: l.cleared ? 'cleared' : i === c.index && !c.finished ? 'active' : 'locked',
      answer: c.finished || i < c.index ? l.word : null,
      guesses: l.guesses.length,
      difficulty: l.difficulty,
    })),
    guesses: cur.guesses.map((g) => ({ word: g.word, pct: g.pct, at: g.at })),
    questions: cur.questions.map((x) => ({ q: x.q, yes: x.yes, at: x.at })),
    /** 整轮已问总数（4 题共享额度） */
    asked: c.levels.reduce((s, l) => s + l.questions.length, 0),
    questionLimit: RULES.questionLimit,
    judgeReady: judgeConfigured(),
    used: c.used,
    guessLimit: RULES.guessLimit,
    startedAt: c.startedAt,
    deadline: c.deadline,
    now,
    rules: RULES,
    hint: !c.finished && cur.guesses.length >= RULES.hintAfter ? { chars: cur.word.length } : null,
    finished: c.finished,
    result: c.result,
    finishedAt: c.finishedAt,
    elapsedMs: Math.max(0, (c.finished ? Math.min(c.finishedAt, c.deadline) : Math.min(now, c.deadline)) - c.startedAt),
    score: c.score,
    rank: c.rank,
    ...(process.env.XUNCI_DEV_HINT === '1' ? { devAnswers: c.levels.map((l) => l.word) } : {}),
  }
}

const findSession = (raw) => sessions.get(String(raw || ''))
const bad = (res, status, error) => res.status(status).json({ error })

export const challengeRouter = Router()

challengeRouter.get('/categories', (req, res) => {
  // categories 是同内容的兼容别名，老版本前端也能正常显示
  res.json({ domains: DOMAIN_VIEW, categories: DOMAIN_VIEW, rules: RULES, judgeReady: judgeConfigured() })
})

challengeRouter.get('/leaderboard', (req, res) => {
  const domain = resolveDomain(req.query.domain ?? req.query.category)
  if (!domain) return bad(res, 400, '没有这个领域')
  const entries = (boards.get(domain) || []).slice(0, 20).map((e, i) => ({ rank: i + 1, ...e }))
  res.json({ domain, category: domain, entries, rules: RULES })
})

challengeRouter.post('/start', async (req, res) => {
  if (!isReady()) return bad(res, 503, '模型正在加载，请稍候')
  const domain = resolveDomain(req.body?.domain ?? req.body?.category)
  if (!domain) return bad(res, 400, '请先选一个领域')
  const playerId = String(req.body?.playerId || req.body?.id || '').slice(0, 64) || randomUUID()
  const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 12) || '匿名玩家'
  try {
    res.json(publicState(await createSession(domain, playerId, name)))
  } catch (e) {
    console.error('challenge start failed', e)
    bad(res, 500, '开局失败，再试一次')
  }
})

challengeRouter.get('/session', (req, res) => {
  const c = findSession(req.query.id)
  if (!c) return bad(res, 404, '这次挑战已经过期了，重新选个领域吧')
  checkTimeout(c)
  res.json(publicState(c))
})

challengeRouter.post('/guess', async (req, res) => {
  const c = findSession(req.body?.id)
  if (!c) return bad(res, 404, '这次挑战已经过期了，重新选个领域吧')
  checkTimeout(c)
  if (c.finished) return bad(res, 400, '这次挑战已经结束了')
  const word = norm(req.body?.word).slice(0, 12)
  if (!word) return bad(res, 400, '请输入一个词')
  if (!/[\u4e00-\u9fa5]/.test(word)) return bad(res, 400, '请用中文词语来猜')
  if (c.busy) return bad(res, 409, '上一次猜测还在算，稍等一下')
  if (c.used >= RULES.guessLimit) {
    finish(c, 'exhausted')
    return res.json({ ...publicState(c), guess: null })
  }

  const level = c.levels[c.index]
  const levelNo = c.index + 1
  const dup = level.guesses.find((g) => g.word === word)
  // 重复猜不消耗总次数，和房间对局保持一致
  if (dup) {
    return res.json({
      ...publicState(c),
      guess: { word, pct: dup.pct, exact: false, dup: true, level: levelNo },
    })
  }

  c.busy = true
  try {
    const pct = await rateGuess(level.word, level.base, word)
    const exact = pct === 100
    level.guesses.push({ word, pct, at: Date.now() })
    c.used++
    if (exact) {
      level.cleared = true
      level.clearedAt = Date.now()
      c.index++
      if (c.index >= RULES.levels) finish(c, 'cleared')
    }
    if (!c.finished) {
      if (Date.now() >= c.deadline) finish(c, 'timeout')
      else if (c.used >= RULES.guessLimit) finish(c, 'exhausted')
    }
    res.json({
      ...publicState(c),
      guess: { word, pct, exact, dup: false, level: levelNo },
    })
  } catch (e) {
    console.error('challenge guess failed', e)
    bad(res, 502, '服务器打了个喷嚏，再试一次')
  } finally {
    c.busy = false
  }
})

// 主玩法问一问：判官站在当前题答案的立场回答"是"的概率。
// 问消耗整轮的问句额度，不消耗猜词次数，也不结束挑战（超时除外）。
challengeRouter.post('/ask', async (req, res) => {
  const c = findSession(req.body?.id)
  if (!c) return bad(res, 404, '这次挑战已经过期了，重新选个领域吧')
  checkTimeout(c)
  if (c.finished) return bad(res, 400, '这次挑战已经结束了')
  if (!judgeConfigured()) return bad(res, 403, '判官未配置（需要 TYPESAFE_API_KEY），用猜词吧')
  const v = checkAsk(req.body?.q)
  if (v.error) return bad(res, 400, v.error)
  if (c.busy) return bad(res, 409, '上一个问题判官还在想，稍等一下')

  const level = c.levels[c.index]
  const levelNo = c.index + 1
  const askedCount = () => c.levels.reduce((s, l) => s + l.questions.length, 0)
  const dup = level.questions.find((x) => x.q === v.q)
  // 同一题里重复问同一个问题直接回缓存答案，不消耗额度
  if (dup) {
    return res.json({
      ...publicState(c),
      answer: { q: v.q, yes: dup.yes, dup: true, asked: askedCount(), level: levelNo },
    })
  }
  if (askedCount() >= RULES.questionLimit) {
    return bad(res, 403, '这轮的是非题用完了，切到猜词收尾吧')
  }

  c.busy = true
  try {
    const yes = await askJudge(v.q, level.word, c.category)
    level.questions.push({ q: v.q, yes, at: Date.now() })
    if (!c.finished && Date.now() >= c.deadline) finish(c, 'timeout')
    res.json({
      ...publicState(c),
      answer: { q: v.q, yes, dup: false, asked: askedCount(), level: levelNo },
    })
  } catch (e) {
    console.error('challenge ask failed', e)
    bad(res, 502, '判官走神了，再问一次')
  } finally {
    c.busy = false
  }
})

challengeRouter.post('/abandon', (req, res) => {
  const c = findSession(req.body?.id)
  if (!c) return bad(res, 404, '这次挑战已经过期了')
  checkTimeout(c)
  if (!c.finished) finish(c, 'abandoned')
  res.json(publicState(c))
})

// 时间到但玩家一直没操作的会话也要落地，并定期回收
setInterval(() => {
  const now = Date.now()
  for (const [id, c] of sessions) {
    checkTimeout(c)
    if (now > c.deadline + 3600_000) sessions.delete(id)
  }
}, 30_000).unref()
