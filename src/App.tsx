import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import * as net from './net'
import { loadMe, saveMe } from './me'
import { loadStats, saveStats, tempOf, type Stats } from './game'
import { isMuted, playDup, playLose, playTap, playTier, setMuted } from './sfx'

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
  const [me, setMe] = useState(() => loadMe())
  const meRef = useRef(me)
  meRef.current = me
  const [snap, setSnap] = useState<api.RoomState | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [boot, setBoot] = useState('正在连接服务器…')
  const [stats, setStats] = useState<Stats>(() => loadStats())
  const [copied, setCopied] = useState(false)
  const [muted, setMutedState] = useState(() => isMuted())
  const [tick, setTick] = useState(Date.now())
  const [nameDraft, setNameDraft] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [mode, setMode] = useState<'guess' | 'ask'>('guess')
  const connRef = useRef<net.Conn | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const gameRef = useRef<api.RoomGame | null>(null)
  const countRef = useRef(0)
  const offsetRef = useRef(0)
  const countedRef = useRef<Set<string>>(new Set())
  const startingRef = useRef(false)

  const game = snap?.game ?? null
  const players = snap?.players ?? []
  const guesses = useMemo(() => game?.guesses ?? [], [game])
  const questions = useMemo(() => game?.questions ?? [], [game])
  const last = guesses.length ? guesses[guesses.length - 1] : null
  const prevGuess = guesses.length > 1 ? guesses[guesses.length - 2] : null

  // 服务端状态到达：更新时钟偏移，新猜词/新问题到达时解除输入锁定并配音效
  const handleState = useCallback((s: api.RoomState) => {
    offsetRef.current = s.now - Date.now()
    setErr('')
    const g = s.game
    const n = (g?.guesses.length ?? 0) + (g?.questions?.length ?? 0)
    if (n !== countRef.current) {
      // 同一局里活动数增加才算"新的"（首次进局/换局的存量记录不响）
      const prev = gameRef.current
      const announce = prev?.id === g?.id && n > countRef.current
      countRef.current = n
      setBusy(false)
      if (announce && g) {
        const grewQ = (g.questions?.length ?? 0) > (prev?.questions?.length ?? 0)
        if (grewQ) {
          // 判官的答案按"是"的概率走热度音：越肯定越烫
          const q = g.questions[g.questions.length - 1]
          window.setTimeout(() => playTier(q.yes), 380)
        } else if (g.finished) {
          if (g.endReason === 'guessed') window.setTimeout(() => playTier(100), 380)
          else window.setTimeout(() => playLose(), 700)
        } else {
          const entry = g.guesses[g.guesses.length - 1]
          window.setTimeout(() => playTier(entry.pct), 380)
        }
      }
    }
    gameRef.current = g
    setSnap(s)
  }, [])

  useEffect(() => {
    const conn = net.connect(
      () => ({ id: meRef.current.id, name: meRef.current.name }),
      {
        onState: handleState,
        onNotice: (ntc) => {
          if (ntc.kind === 'dup') playDup()
          setErr(ntc.message)
          setBusy(false)
        },
        onClose: () => setErr('连接断开，正在重连…'),
      },
    )
    connRef.current = conn
    return () => {
      connRef.current = null
      conn.close()
    }
  }, [handleState])

  const start = useCallback(async () => {
    setErr('')
    let delay = 800
    for (let i = 0; i < 40; i++) {
      try {
        await api.newGame()
        setBoot('')
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

  // 房间还没有局（首次进入/服务端重启）→ 自动开局
  useEffect(() => {
    if (!snap || !snap.ready || snap.game || startingRef.current) return
    startingRef.current = true
    void start().finally(() => {
      startingRef.current = false
    })
  }, [snap, start])

  // 引导文案跟随连接/模型状态
  useEffect(() => {
    if (!snap) setBoot('正在连接服务器…')
    else if (!snap.ready) setBoot('正在唤醒语言模型…')
    else setBoot('')
  }, [snap])

  // 模型加载期间没有广播，轮询兜底
  useEffect(() => {
    if (!snap || snap.ready) return
    const t = window.setInterval(() => {
      void api
        .roomState()
        .then((s) => setSnap(s))
        .catch(() => {})
    }, 2000)
    return () => window.clearInterval(t)
  }, [snap])

  // 计时：局内每秒走一次，结算后停住（用服务端时钟偏移换算）
  const gameId = game?.id
  const done = game?.finished ?? true
  useEffect(() => {
    if (!gameId || done) return
    const t = window.setInterval(() => setTick(Date.now() + offsetRef.current), 1000)
    return () => window.clearInterval(t)
  }, [gameId, done])

  // 新局开始时聚焦输入框
  useEffect(() => {
    if (!gameId || done) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 150)
    return () => window.clearTimeout(t)
  }, [gameId, done])

  // 一局结束时计入本地统计：猜中归功于猜中的人
  const best = useMemo(() => (guesses.length ? guesses.reduce((a, b) => (b.pct > a.pct ? b : a)) : null), [guesses])
  useEffect(() => {
    if (!game?.finished || countedRef.current.has(game.id)) return
    countedRef.current.add(game.id)
    const won = game.winnerId === me.id
    const topPct = best?.pct ?? 0
    setStats((prev) => {
      const next: Stats = {
        plays: prev.plays + 1,
        wins: prev.wins + (won ? 1 : 0),
        bestPct: Math.max(prev.bestPct, won ? 100 : topPct),
        fewest: won ? (prev.fewest ? Math.min(prev.fewest, game.guesses.length) : game.guesses.length) : prev.fewest,
      }
      saveStats(next)
      return next
    })
  }, [game, me.id, best])

  const pct = last?.pct ?? 0
  const shown = useAnimatedNumber(pct)
  const temp = tempOf(pct)
  const hasGuess = last !== null
  const sorted = useMemo(() => [...guesses].sort((a, b) => b.pct - a.pct), [guesses])

  const delta = last && prevGuess ? pct - prevGuess.pct : null
  const winner = game?.winnerId ? players.find((p) => p.id === game.winnerId)?.name ?? null : null
  const over = game?.finished
    ? { won: game.winnerId === me.id, answer: game.answer ?? '??', reason: game.endReason, winner }
    : null

  // 分类提示进度：猜满 categoryAt 次才解锁
  const catAt = game?.categoryAt ?? 10
  const catLeft = Math.max(0, catAt - guesses.length)

  function toggleMute() {
    const next = !muted
    setMuted(next)
    setMutedState(next)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!game || !text || busy || game.finished) return
    setBusy(true)
    setErr('')
    playTap()
    if (mode === 'ask') {
      connRef.current?.send({ type: 'ask', q: text })
      // 判官要等模型回话，兜底解锁放宽到 20s
      window.setTimeout(() => setBusy(false), 20000)
    } else {
      connRef.current?.send({ type: 'guess', word: text })
      // 网络兜底：状态广播或提示没来也要解锁输入
      window.setTimeout(() => setBusy(false), 4000)
    }
    setInput('')
  }

  function giveUp() {
    if (!game || game.finished) return
    connRef.current?.send({ type: 'reveal' })
  }

  function beginRename() {
    setNameDraft(me.name)
    setEditingName(true)
  }

  function commitRename() {
    setEditingName(false)
    const name = nameDraft.trim().slice(0, 12)
    if (!name || name === me.name) return
    const next = { ...me, name }
    setMe(next)
    saveMe(next)
    connRef.current?.send({ type: 'rename', name })
  }

  async function copyResult() {
    if (!over) return
    const rows = sorted.slice(0, 6).map((g) => `${g.word} ${g.pct}`).join(' · ')
    const who = over.winner ? `（${over.winner} 猜中）` : ''
    const text = `寻词蹭热度 · ${game?.category ?? ''}\n${over.won ? '蹭到了' : '没蹭上'}：${over.answer}${who}\n${rows}`
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setErr('复制失败了，手动截图吧')
    }
  }

  const heat = Math.min(1, Math.max(0, pct / 100))
  const startedAt = game?.startedAt ?? null
  const endedAt = game?.finished ? game.endedAt : null

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
        {game?.category ? (
          <span className="chip cat unlocked">提示 · {game.category}</span>
        ) : game?.categoryAt != null ? (
          <span className="chip cat locked">分类 · 再猜 {catLeft} 次解锁</span>
        ) : null}
        {game?.hint && <span className="chip">{game.hint.chars} 个字</span>}
        <span className="tally">
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
        </span>
      </div>

      <div className="players">
        <span className="pc">{snap ? `在线 ${players.length} 人` : '连接中…'}</span>
        {players.map((p) =>
          p.id === me.id && editingName ? (
            <input
              key={p.id}
              className="name-edit"
              value={nameDraft}
              autoFocus
              maxLength={12}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setEditingName(false)
              }}
            />
          ) : (
            <button
              key={p.id}
              className={p.id === me.id ? 'p me' : 'p'}
              onClick={() => p.id === me.id && beginRename()}
              title={p.id === me.id ? '点击改名' : p.name}
            >
              {p.name}
            </button>
          ),
        )}
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
              <span className="lastword">「{last?.word}」</span>
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

      <div className="modes" role="tablist">
        <button
          className={mode === 'guess' ? 'mode-btn on' : 'mode-btn'}
          onClick={() => setMode('guess')}
          role="tab"
          aria-selected={mode === 'guess'}
        >
          猜词
        </button>
        <button
          className={mode === 'ask' ? 'mode-btn on' : 'mode-btn'}
          onClick={() => setMode('ask')}
          role="tab"
          aria-selected={mode === 'ask'}
        >
          问一句
          <em>
            {questions.length}/{game?.questionLimit ?? 10}
          </em>
        </button>
      </div>

      <form className="entry" onSubmit={submit}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            over
              ? '这一局结束了'
              : mode === 'ask'
                ? questions.length >= (game?.questionLimit ?? 10)
                  ? '问题额度用完了，猜词吧'
                  : '问一个是非题，如：它是吃的吗？'
                : '输入一个词，蹭蹭看'
          }
          maxLength={mode === 'ask' ? 40 : 12}
          disabled={!game || busy || !!over || (mode === 'ask' && questions.length >= (game?.questionLimit ?? 10))}
          enterKeyHint="send"
          autoComplete="off"
        />
        <button type="submit" disabled={!game || busy || !input.trim() || !!over || (mode === 'ask' && questions.length >= (game?.questionLimit ?? 10))}>
          {busy ? '…' : mode === 'ask' ? '问一下' : '蹭一下'}
        </button>
      </form>

      {err && <div className="err">{err}</div>}

      {questions.length > 0 && (
        <section className="quiz">
          <div className="qhead">
            <span>问过的是非题</span>
            <span className="hsub">判官的判断 · 条越长越笃定</span>
          </div>
          <ul className="qlist">
            {questions.map((q) => {
              const yes = q.yes >= 50
              const conf = Math.round(yes ? q.yes : 100 - q.yes)
              return (
                <li key={q.at} className={yes ? 'ans-yes' : 'ans-no'}>
                  <span className="qt" title={`${q.by} 问的`}>{q.q}</span>
                  <span className="qbar">
                    <i style={{ width: `${Math.max(2, conf)}%` }} />
                  </span>
                  <span className="qv">{yes ? '是' : '否'} {conf}%</span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

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
              <span className="by" title={`${g.by} 猜的`}>{g.by}</span>
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
            <button className="ghost danger" onClick={giveUp} disabled={!game || !guesses.length || game.allowReveal === false}>
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
              {over.won ? (
                <>
                  「{over.winner ?? '有人'}」猜中了 · 用了 {guesses.length} 次
                </>
              ) : over.reason === 'revealed' ? (
                <>有人放弃了 · 最高热度 {best?.pct ?? 0}</>
              ) : (
                <>{game?.attempts ?? 30} 次机会用完了 · 最高热度 {best?.pct ?? 0}</>
              )}
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
