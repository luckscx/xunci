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
  game: RoomGame | null
  players: Player[]
}

export type Notice = { type: 'notice'; kind: 'error' | 'dup'; message: string }

export type NewGame = { id: string; category: string; difficulty: number; attempts: number; answer?: string }

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
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
  const res = await fetch('/api/state')
  if (!res.ok) throw new Error('状态拉取失败')
  return (await res.json()) as RoomState
}
