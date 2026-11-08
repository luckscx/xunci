import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import * as net from './net'
import { loadMe } from './me'
import { tempOf } from './game'
import { isMuted, playDup, playLose, playTap, playTier, setMuted } from './sfx'

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

const confOf = (yes: number) => ({ yes: yes >= 50, conf: Math.round(yes >= 50 ? yes : 100 - yes) })

export default function App() {
  const [me] = useState(() => loadMe())
  const [snap, setSnap] = useState<api.RoomState | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [boot, setBoot] = useState('正在连接服务器…')
  const [muted, setMutedState] = useState(() => isMuted())
  const [mode, setMode] = useState<'guess' | 'ask'>('guess')
  const connRef = useRef<net.Conn | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const gameRef = useRef<api.RoomGame | null>(null)
  const countRef = useRef(0)
  const startingRef = useRef(false)

  const game = snap?.game ?? null
  const players = snap?.players ?? []
  const guesses = game?.guesses ?? []
  const questions = game?.questions ?? []
  const last = guesses.length ? guesses[guesses.length - 1] : null
  const lastQ = questions.length ? questions[questions.length - 1] : null

  // 服务端状态到达：新猜词/新答案到达时解除输入锁定并配音效
  const handleState = useCallback((s: api.RoomState) => {
    setErr('')
    const g = s.game
    const n = (g?.guesses.length ?? 0) + (g?.questions?.length ?? 0)
    if (n !== countRef.current) {
      // 同一局里活动数增加才算「新的」（首次进局/换局的存量记录不响）
      const prev = gameRef.current
      const announce = prev?.id === g?.id && n > countRef.current
      countRef.current = n
      setBusy(false)
      if (announce && g) {
        const grewQ = (g.questions?.length ?? 0) > (prev?.questions?.length ?? 0)
        if (grewQ) {
          window.setTimeout(() => playTier(g.questions[g.questions.length - 1].yes), 380)
        } else if (g.finished) {
          if (g.endReason === 'guessed') window.setTimeout(() => playTier(100), 380)
          else window.setTimeout(() => playLose(), 700)
        } else {
          window.setTimeout(() => playTier(g.guesses[g.guesses.length - 1].pct), 380)
        }
      }
    }
    gameRef.current = g
    setSnap(s)
  }, [])

  useEffect(() => {
    const conn = net.connect(() => me, {
      onState: handleState,
      onNotice: (ntc) => {
        if (ntc.kind === 'dup') playDup()
        setErr(ntc.message)
        setBusy(false)
      },
      onClose: () => setErr('连接断开，正在重连…'),
    })
    connRef.current = conn
    return () => {
      connRef.current = null
      conn.close()
    }
  }, [handleState, me])

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
        setBoot(status === 503 ? '引擎正在热身…' : '正在连接引擎…')
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

  // 新局开始时聚焦输入框
  const gameId = game?.id
  const done = game?.finished ?? true
  useEffect(() => {
    if (!gameId || done) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 150)
    return () => window.clearTimeout(t)
  }, [gameId, done])

  const pct = last?.pct ?? 0
  const shown = useAnimatedNumber(pct)
  const temp = tempOf(pct)
  const sorted = useMemo(() => [...guesses].sort((a, b) => b.pct - a.pct), [guesses])
  const bestPct = sorted[0]?.pct ?? 0

  const attempts = game?.attempts ?? 30
  const left = Math.max(0, attempts - guesses.length)
  const qLimit = game?.questionLimit ?? 10
  const qLeft = Math.max(0, qLimit - questions.length)
  const catLeft = Math.max(1, (game?.categoryAt ?? 10) - guesses.length)
  const q = lastQ ? confOf(lastQ.yes) : null

  const over = game?.finished
    ? {
        won: game.winnerId === me.id,
        answer: game.answer ?? '??',
        reason: game.endReason,
        winner: game.winnerId ? players.find((p) => p.id === game.winnerId)?.name ?? null : null,
      }
    : null

  const heat = Math.min(1, Math.max(0, pct / 100))
  const hint = game?.category
    ? `提示 · ${game.category}${game.hint ? ` · ${game.hint.chars} 个字` : ''}`
    : game?.categoryAt == null
      ? '提示 · 本局关闭'
      : `提示 · 再猜 ${catLeft} 次解锁`

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
      window.setTimeout(() => setBusy(false), 4000)
    }
    setInput('')
  }

  function giveUp() {
    if (!game || game.finished) return
    connRef.current?.send({ type: 'reveal' })
  }

  const askFull = qLeft === 0
  const disabled = !game || busy || !!over || (mode === 'ask' && askFull)
  const placeholder = over
    ? '这一局结束了'
    : mode === 'ask'
      ? askFull
        ? '问题用完了，切回猜词吧'
        : '问一个是非题，如：它是吃的吗？'
      : '输入一个词，看看离答案多近'

  return (
    <div
      className="app"
      style={{ ['--hue' as string]: String(temp.hue), ['--heat' as string]: String(heat) }}
    >
      <div className="bg" aria-hidden />

      <header className="top">
        <span className="logo">寻词</span>
        <span className="tally">
          还剩 <b>{left}</b> 次
        </span>
        <button className="snd" onClick={toggleMute} aria-label={muted ? '打开音效' : '关闭音效'} title={muted ? '打开音效' : '关闭音效'}>
          {muted ? (
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
              <path d="M4 9.5v5h3l4 3.5V6L7 9.5H4z" fill="currentColor" />
              <path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
              <path d="M4 9.5v5h3l4 3.5V6L7 9.5H4z" fill="currentColor" />
              <path d="M15.2 9a4.4 4.4 0 010 6M18 6.2a8 8 0 010 11.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
            </svg>
          )}
        </button>
      </header>

      {/* 两种玩法共用一个入口：切 tab 同时切换焦点反馈和下方记录 */}
      <div className="modes" role="tablist">
        <button className={mode === 'guess' ? 'mode-btn on' : 'mode-btn'} onClick={() => setMode('guess')} role="tab" aria-selected={mode === 'guess'}>
          猜词
        </button>
        <button className={mode === 'ask' ? 'mode-btn on' : 'mode-btn'} onClick={() => setMode('ask')} role="tab" aria-selected={mode === 'ask'}>
          问一句<em>{qLeft} 问</em>
        </button>
      </div>

      {/* 焦点卡：只回答「我现在离答案多近 / 判官刚说了什么」 */}
      <section className={`gauge ${mode === 'ask' ? 'ask' : ''}`}>
        {mode === 'guess' ? (
          <>
            <div className="num">
              {last ? shown : '?'}
              <span className="unit">/ 100</span>
            </div>
            <div className="verdict">
              <b>{last ? temp.label : '猜一个词'}</b>
              <span>{last ? `「${last.word}」` : '越靠近答案，热度越高'}</span>
            </div>
          </>
        ) : (
          <>
            <div className={`num ${q?.yes ? 'q-yes' : 'q-no'}`}>{q ? (q.yes ? '是' : '否') : '?'}</div>
            <div className="verdict">
              <b>{q ? `${q.conf}% 把握` : '问一个是非题'}</b>
              <span>{q ? `「${lastQ?.q}」` : '判官会回答是或否'}</span>
            </div>
          </>
        )}
        <div className="thermo">
          <div
            className="fill"
            style={{
              width: `${mode === 'guess' ? Math.max(2, pct) : Math.max(2, q?.conf ?? 0)}%`,
              background: mode === 'ask' ? (q?.yes ? '#74c9ad' : '#7f8ba3') : `hsl(${temp.hue} 90% 64%)`,
            }}
          />
        </div>
        <div className="chips">
          <span className={`chip cat ${game?.category ? 'unlocked' : 'locked'}`}>{hint}</span>
        </div>
      </section>

      {/* 一个列表，跟着玩法走：猜词按热度排序，问句按时间倒序 */}
      <section className="history">
        <div className="hhead">
          <span>{mode === 'guess' ? '猜过的词' : '问过的是非题'}</span>
          <span className="hsub">{mode === 'guess' ? (guesses.length ? `最热 ${bestPct}` : '按热度排') : `还剩 ${qLeft} 问`}</span>
        </div>
        {mode === 'guess' ? (
          guesses.length ? (
            <ul className="hlist">
              {sorted.map((g, i) => (
                <li key={g.word} className={i === 0 && guesses.length > 1 ? 'lead' : ''}>
                  <span className="w">{g.word}</span>
                  <span className="bar">
                    <i style={{ width: `${Math.max(2, g.pct)}%`, background: `hsl(${Math.round(205 - Math.min(1, g.pct / 100) * 198)} 88% 62%)` }} />
                  </span>
                  <span className="v">{g.pct}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty">猜过的词和热度会记在这里，越靠上越接近答案</div>
          )
        ) : questions.length ? (
          <ul className="hlist">
            {[...questions].reverse().map((item) => {
              const v = confOf(item.yes)
              return (
                <li key={item.at} className={v.yes ? 'lead' : ''}>
                  <span className="w">{item.q}</span>
                  <span className={`qv ${v.yes ? 'yes' : 'no'}`}>
                    {v.yes ? '是' : '否'} {v.conf}%
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="empty">问过的问题和判官的回答会记在这里</div>
        )}
      </section>

      <form className="entry" onSubmit={submit}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          maxLength={mode === 'ask' ? 40 : 12}
          disabled={disabled}
          enterKeyHint="send"
          autoComplete="off"
        />
        <button type="submit" disabled={disabled || !input.trim()}>
          {busy ? '…' : mode === 'ask' ? '问一下' : '蹭一下'}
        </button>
      </form>

      {err && <div className="err">{err}</div>}

      <footer className="foot">
        {!over ? (
          <>
            <button className="ghost" onClick={() => void start()} disabled={!game}>
              换一个词
            </button>
            <button className="ghost danger" onClick={giveUp} disabled={!game || !guesses.length || game.allowReveal === false}>
              看答案
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
          <p>首次启动需要加载词向量模型，稍等片刻</p>
        </div>
      )}

      {over && (
        <div className="overlay">
          <div className="panel">
            <div className={`verdict-badge ${over.won ? 'win' : 'lose'}`}>{over.won ? '蹭到了' : '没蹭上'}</div>
            <div className="answer">{over.answer}</div>
            <div className="sub">
              {over.won
                ? `你猜中了 · 用了 ${guesses.length} 次`
                : over.winner
                  ? `${over.winner} 猜中了 · ${guesses.length} 次`
                  : over.reason === 'revealed'
                    ? `答案揭晓 · 最高热度 ${bestPct}`
                    : `${attempts} 次用完 · 最高热度 ${bestPct}`}
            </div>
            <div className="panel-actions">
              <button className="primary" onClick={() => void start()}>
                再来一局
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
