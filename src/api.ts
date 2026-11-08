export type Identity = { id: string; name: string }
export type Player = { id: string; name: string }
export type Entry = { word: string; pct: number; by: string; byId: string | null; at: number }
export type QuestionEntry = { q: string; yes: number; by: string; byId: string | null; at: number }
export type EndReason = 'guessed' | 'revealed' | 'exhausted'

export type RoomGame = {
  id: string
  /** 分类提示：猜满 categoryAt 次才解锁；null = 管理员关闭了分类提示 */
  category: string | null
  categoryAt: number | null
  difficulty: number
  attempts: number
  startedAt: number
  guesses: Entry[]
  questions: QuestionEntry[]
  questionLimit: number
  /** 管理员是否允许「放弃，看答案」 */
  allowReveal: boolean
  finished: boolean
  endedAt: number | null
  endReason: EndReason | null
  winnerId: string | null
  answer?: string
  hint?: { chars: number } | null
}

export type RoomState = {
  type: 'state'
  now: number
  ready: boolean
  /** 判官（问一问）是否可用；缺失时按可用处理，兼容旧服务端 */
  judgeReady?: boolean
  game: RoomGame | null
  players: Player[]
}

export type Notice = { type: 'notice'; kind: 'error' | 'dup'; message: string }

export type NewGame = { id: string; category: string; difficulty: number; attempts: number; answer?: string }

async function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error((data as { error?: string }).error || '网络开小差了') as Error & { status: number }
    err.status = res.status
    throw err
  }
  return data as T
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error((data as { error?: string }).error || '网络开小差了') as Error & { status: number }
    err.status = res.status
    throw err
  }
  return data as T
}

/** 开一局新的公共房间局（服务端会向所有客户端广播） */
export const newGame = () => post<NewGame>('/api/game')

/** 拉取当前房间快照（模型加载期间的轮询兜底） */
export async function roomState(): Promise<RoomState> {
  return get<RoomState>('/api/state')
}

// ---------- 闯关模式 ----------
export type ChallengeRules = {
  levels: number
  timeLimitMs: number
  questionLimit: number
  guessLimit: number
  perGuessSeconds: number
  hintAfter: number
}
/** 聚合后的领域：把词库里几个相近的细分分类收成一组 */
export type ChallengeDomain = { name: string; count: number; groups: string[] }
export type ChallengeLevel = {
  state: 'cleared' | 'active' | 'locked'
  answer: string | null
  guesses: number
  difficulty: number
}
export type ChallengeGuessEntry = { word: string; pct: number; at: number }
export type ChallengeResult = 'cleared' | 'timeout' | 'exhausted' | 'abandoned' | null

export type ChallengeState = {
  id: string
  /** 聚合领域名（沿用 category 字段名） */
  category: string
  name: string
  playerId: string
  total: number
  index: number
  level: number
  levels: ChallengeLevel[]
  /** 当前这一题猜过的词 */
  guesses: ChallengeGuessEntry[]
  /** 当前这一题问过的是非题 */
  questions: { q: string; yes: number; at: number }[]
  /** 整轮已问总数（4 题共享额度） */
  asked: number
  questionLimit: number
  /** 判官是否可用；不可用时闯关自动只用猜词 */
  judgeReady: boolean
  used: number
  guessLimit: number
  startedAt: number
  deadline: number
  /** 服务端时钟，前端据此抵消本地时钟偏差 */
  now: number
  rules: ChallengeRules
  hint: { chars: number } | null
  finished: boolean
  result: ChallengeResult
  finishedAt: number | null
  elapsedMs: number
  score: number | null
  rank: number | null
  devAnswers?: string[]
}

export type ChallengeGuessResult = ChallengeState & {
  guess: { word: string; pct: number; exact: boolean; dup: boolean; level: number } | null
}
export type ChallengeAskResult = ChallengeState & {
  answer: { q: string; yes: number; dup: boolean; asked: number; level: number } | null
}
export type BoardEntry = {
  rank: number
  playerId: string
  name: string
  used: number
  seconds: number
  score: number
  at: number
}

export const challengeDomains = () =>
  get<{ domains: ChallengeDomain[]; rules: ChallengeRules; judgeReady: boolean }>('/api/challenge/categories')
export const challengeLeaderboard = (domain: string) =>
  get<{ domain: string; entries: BoardEntry[]; rules: ChallengeRules }>(
    `/api/challenge/leaderboard?domain=${encodeURIComponent(domain)}`,
  )
export const challengeStart = (domain: string, me: Identity) =>
  post<ChallengeState>('/api/challenge/start', { domain, playerId: me.id, name: me.name })
export const challengeSession = (id: string) =>
  get<ChallengeState>(`/api/challenge/session?id=${encodeURIComponent(id)}`)
export const challengeGuess = (id: string, word: string, signal?: AbortSignal) =>
  post<ChallengeGuessResult>('/api/challenge/guess', { id, word }, signal)
export const challengeAsk = (id: string, q: string, signal?: AbortSignal) =>
  post<ChallengeAskResult>('/api/challenge/ask', { id, q }, signal)
export const challengeAbandon = (id: string) => post<ChallengeState>('/api/challenge/abandon', { id })
