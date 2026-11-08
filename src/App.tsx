import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import { loadStats, saveStats, tempOf, type Stats } from './game'
import { isMuted, playDup, playLose, playTap, playTier, setMuted } from './sfx'

type Guess = { word: string; pct: number }

// 卡在中间时的引导语：告诉玩家"再往里走"该往哪个方向想
const COACH = [
  '卡在这一带＝你摸到的是话题，还没摸到它本身',
  '试试带它字的词：它的零件、它的变体、它的名字延伸',
  '换个场景想：它会在哪儿出现？谁在用？',
  '试试更小的词：它不是一类东西，是一个具体的东西',
]

const fmtClock = (ts: number) =>
  new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

const fmtDur = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function useAnimatedNumber(target: number, ms = 520) {
  const [val, setVal] = useState(target)
  const fromRef = useRef(target)
  const rafRef = useRef(0)
  useEffect(() => {
    const from = fromRef.current
    if (from === target) return
    const t0 = performance.now()
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      const v = Math.round(from + (target - from) * e)
      setVal(v)
      if (k < 1) rafRef.current = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, ms])
  return val
}

export default function App() {
  const [game, setGame] = useState<api.NewGame | null>(null)
  const [guesses, setGuesses] = useState<Guess[]>([])
  const [last, setLast] = useState<api.GuessResult | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [boot, setBoot] = useState('正在唤醒语言模型…')
  const [over, setOver] = useState<{ won: boolean; answer: string } | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats>(() => loadStats())
  const [copied, setCopied] = useState(false)
  const [muted, setMutedState] = useState(() => isMuted())
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [endedAt, setEndedAt] = useState<number | null>(null)
  const [tick, setTick] = useState(Date.now())
  const inputRef = useRef<HTMLInputElement>(null)

  const start = useCallback(async () => {
    setOver(null)
    setGuesses([])
    setLast(null)
    setInput('')
    setErr('')
    setGame(null)
    setCategory(null)
    setEndedAt(null)
    setStartedAt(null)
    let delay = 800
    for (let i = 0; i < 40; i++) {
      try {
        const g = await api.newGame()
        const now = Date.now()
        setGame(g)
        setStartedAt(now)
        setTick(now)
        setBoot('')
        setTimeout(() => inputRef.current?.focus(), 150)
        return
      } catch (e) {
        const status = (e as { status?: number }).status
        setBoot(status === 503 ? '引擎正在热身，马上就好…' : '正在连接引擎…')
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(4000, delay * 1.4)
      }
    }
    setErr('引擎迟迟没有响应，刷新页面试试')
  }, [])

  useEffect(() => {
    void start()
  }, [start])

  // 计时：局内每秒走一次，结算后停住
  useEffect(() => {
    if (!startedAt || endedAt) return
    const t = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [startedAt, endedAt])

  const pct = last?.pct ?? 0
  const shown = useAnimatedNumber(pct)
  const temp = tempOf(pct)
  const hasGuess = last !== null
  const best = useMemo(() => (guesses.length ? guesses.reduce((a, b) => (b.pct > a.pct ? b : a)) : null), [guesses])
  const sorted = useMemo(() => [...guesses].sort((a, b) => b.pct - a.pct), [guesses])

  const delta = last && last.prev !== null && !last.dup ? pct - last.prev : null

  const finish = useCallback(
    (won: boolean, answer: string, used: number) => {
      setOver({ won, answer })
      setEndedAt(Date.now())
      setStats((prev) => {
        const next: Stats = {
          plays: prev.plays + 1,
          wins: prev.wins + (won ? 1 : 0),
          bestPct: Math.max(prev.bestPct, won ? 100 : (best?.pct ?? 0)),
          fewest: won ? (prev.fewest ? Math.min(prev.fewest, used) : used) : prev.fewest,
        }
        saveStats(next)
        return next
      })
    },
    [best],
  )

  function toggleMute() {
    const next = !muted
    setMuted(next)
    setMutedState(next)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const word = input.trim()
    if (!game || !word || busy || over) return
    setBusy(true)
    setErr('')
    playTap()
    try {
      const r = await api.guess(game.id, word)
      if (r.dup) {
        playDup()
        if (r.category) setCategory(r.category)
        setErr(`「${word}」猜过了，换一个`)
        setInput('')
        return
      }
      setLast(r)
      if (r.category) setCategory(r.category)
      setGuesses((prev) => [...prev, { word, pct: r.pct }])
      setInput('')
      // 数字滚动到落定再响，声音落在"揭晓"这一刻
      window.setTimeout(() => playTier(r.pct), 380)
      if (r.exact) finish(true, r.answer || word, guesses.length + 1)
      else if (r.attemptsLeft <= 0) {
        window.setTimeout(() => playLose(), 700)
        finish(false, r.answer || '??', guesses.length + 1)
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  async function giveUp() {
    if (!game) return
    try {
      const r = await api.reveal(game.id)
      finish(false, r.answer, guesses.length)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function copyResult() {
    if (!over) return
    const rows = sorted.slice(0, 6).map((g) => `${g.word} ${g.pct}`).join(' · ')
    const text = `寻词蹭热度 · ${category ?? ''}\n${over.won ? '蹭到了' : '没蹭上'}：${over.answer}\n${rows}`
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setErr('复制失败了，手动截图吧')
    }
  }

  const heat = Math.min(1, Math.max(0, pct / 100))
  const catAt = game?.categoryAt ?? 10
  const catLeft = Math.max(0, catAt - guesses.length)

  return (
    <div
      className="app"
      style={{ ['--hue' as string]: String(temp.hue), ['--heat' as string]: String(heat) }}
    >
      <div className="bg" aria-hidden />
      <header className="top">
        <div className="brand">
          <span className="logo">寻词蹭热度</span>
          <span className="tag">你猜的词，能蹭到多少热度</span>
        </div>
        <div className="stats">
          第 {stats.plays + (over ? 0 : 1)} 局
          {stats.wins > 0 && <span className="dot">·</span>}
          {stats.wins > 0 && <>猜中 {stats.wins}</>}
        </div>
        <button className="snd" onClick={toggleMute} aria-label={muted ? '打开音效' : '关闭音效'} title={muted ? '打开音效' : '关闭音效'}>
          {muted ? (
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
              <path d="M4 9.5v5h3l4 3.5V6L7 9.5H4z" fill="currentColor" />
              <path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
              <path d="M4 9.5v5h3l4 3.5V6L7 9.5H4z" fill="currentColor" />
              <path d="M15.2 9a4.4 4.4 0 010 6M18 6.2a8 8 0 010 11.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
            </svg>
          )}
        </button>
      </header>

      <div className="chips">
        {category ? (
          <span className="chip cat unlocked">提示 · {category}</span>
        ) : (
          <span className="chip cat locked">
            {game ? `分类 · 再猜 ${catLeft} 次解锁` : '分类 · …'}
          </span>
        )}
        {last?.hint && <span className="chip">共 {last.hint.chars} 个字</span>}
      </div>

      <section className={`gauge ${hasGuess ? 'live' : ''}`}>
        <div className="num">
          {hasGuess ? shown : '?'}
          <span className="unit">热度</span>
        </div>
        <div className="verdict">
          {hasGuess ? (
            <>
              <b>{temp.label}</b>
              <span>{temp.desc}</span>
            </>
          ) : (
            <>
              <b>还没有热度</b>
              <span>随便写个词，蹭蹭看能烧到几度</span>
            </>
          )}
        </div>
        <div className="thermo">
          {[8, 20, 36, 51, 66, 81, 95].map((p) => (
            <i key={p} className="tick" style={{ left: `${p}%` }} />
          ))}
          <div className="veil" style={{ left: `${hasGuess ? Math.max(2, pct) : 0}%` }} />
        </div>
        <div className="meta">
          {hasGuess ? (
            <>
              <span className="lastword">「{guesses[guesses.length - 1]?.word}」</span>
              {delta !== null && delta !== 0 && (
                <span className={delta > 0 ? 'up' : 'down'}>
                  {delta > 0 ? '↑' : '↓'} 比上次 {delta > 0 ? '+' : ''}
                  {delta}
                </span>
              )}
              {delta === 0 && <span className="flat">和上次一样热</span>}
            </>
          ) : (
            <span className="lastword">100 热度 就是答案本身</span>
          )}
        </div>
        {hasGuess && !over && pct >= 26 && pct < 75 && <div className="coach">{COACH[guesses.length % COACH.length]}</div>}
      </section>

      <form className="entry" onSubmit={submit}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={over ? '这一局结束了' : '输入一个词，蹭蹭看'}
          maxLength={12}
          disabled={!game || busy || !!over}
          enterKeyHint="send"
          autoComplete="off"
        />
        <button type="submit" disabled={!game || busy || !input.trim() || !!over}>
          {busy ? '…' : '蹭一下'}
        </button>
      </form>

      {err && <div className="err">{err}</div>}

      <div className="tally">
        <span>
          开始 <b>{startedAt ? fmtClock(startedAt) : '--:--'}</b>
        </span>
        <i />
        <span>
          用时 <b>{startedAt ? fmtDur((endedAt ?? tick) - startedAt) : '00:00'}</b>
        </span>
        <i />
        <span>
          已猜 <b>{guesses.length}</b>
          <em>/{game?.attempts ?? 30}</em>
        </span>
      </div>

      <section className="history">
        <div className="hhead">
          <span>猜过的词</span>
          <span className="hsub">{guesses.length ? '按热度排序' : '会记在这里'}</span>
        </div>
        <ul className={`hlist${guesses.length ? '' : ' is-empty'}`}>
          {sorted.map((g, i) => (
            <li key={g.word} className={i === 0 && guesses.length > 1 ? 'lead' : ''}>
              <span className="rank">{i + 1}</span>
              <span className="w">{g.word}</span>
              <span className="bar">
                <i
                  style={{
                    width: `${Math.max(2, g.pct)}%`,
                    background: `hsl(${Math.round(205 - Math.min(1, g.pct / 100) * 198)} 88% 62%)`,
                  }}
                />
              </span>
              <span className="v">{g.pct}</span>
            </li>
          ))}
        </ul>
        {!guesses.length && (
          <div className="legend">
            <div className="lg">
              <b>0–8 热度</b> 一点边都不沾
            </div>
            <div className="lg">
              <b>20–50 热度</b> 蹭到边了，顺着这个方向爬
            </div>
            <div className="lg">
              <b>70+ 热度</b> 就在附近，换同义词、近义词再蹭
            </div>
          </div>
        )}
      </section>

      <footer className="foot">
        {!over ? (
          <>
            <button className="ghost" onClick={() => void start()} disabled={!game}>
              换一个词
            </button>
            <button className="ghost danger" onClick={() => void giveUp()} disabled={!game || !guesses.length}>
              放弃，看答案
            </button>
          </>
        ) : (
          <button className="primary" onClick={() => void start()}>
            再来一局
          </button>
        )}
      </footer>

      {boot && (
        <div className="boot">
          <div className="spinner" />
          <div>{boot}</div>
          <p>第一次启动要把 100MB 的词向量模型读进内存，大约十几秒。</p>
        </div>
      )}

      {over && (
        <div className="overlay">
          <div className="panel">
            <div className={`verdict-badge ${over.won ? 'win' : 'lose'}`}>{over.won ? '蹭到了' : '没蹭上'}</div>
            <div className="answer">{over.answer}</div>
            <div className="sub">
              {over.won
                ? `用了 ${guesses.length} 次 · 最高热度 ${best?.pct ?? 0}`
                : `${game?.attempts ?? 30} 次机会用完了 · 最高热度 ${best?.pct ?? 0}`}
              {startedAt && <> · 用时 {fmtDur((endedAt ?? tick) - startedAt)}</>}
            </div>
            <div className="trail">
              {sorted.slice(0, 5).map((g) => (
                <span key={g.word} className="tchip">
                  {g.word} <b>{g.pct}</b>
                </span>
              ))}
            </div>
            <div className="panel-actions">
              <button className="primary" onClick={() => void start()}>
                再来一局
              </button>
              <button className="ghost" onClick={() => void copyResult()}>
                {copied ? '已复制' : '复制战绩'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
