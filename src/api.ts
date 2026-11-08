export type NewGame = { id: string; category: string; difficulty: number; attempts: number }
export type GuessResult = {
  pct: number
  exact: boolean
  dup?: boolean
  rank?: number
  attemptsLeft: number
  best: { word: string; pct: number } | null
  prev: number | null
  answer?: string
  hint?: { chars: number } | null
}

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

export const newGame = () => post<NewGame>('/api/game')
export const guess = (id: string, word: string) => post<GuessResult>('/api/guess', { id, word })
export const reveal = (id: string) => post<{ answer: string }>('/api/reveal', { id })
