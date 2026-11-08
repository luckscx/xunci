import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import { confOf, tempOf } from './game'
import { playDup, playLose, playTap, playTier } from './sfx'
import './challenge.css'

const SESSION_KEY = 'xunci.challenge.v1'

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

type Screen = 'pick' | 'board' | 'run'

/** 选领域 → 连闯 4 题 → 结算上榜；主玩法问一问，猜词收尾，时间与次数全部由服务端裁定 */
export default function Challenge({ me }: { me: api.Identity }) {
  const [screen, setScreen] = useState<Screen>('pick')
  const [domains, setDomains] = useState<api.ChallengeDomain[]>([])
  const [rules, setRules] = useState<api.ChallengeRules | null>(null)
  const [session, setSession] = useState<api.ChallengeState | null>(null)
  const [boardDomain, setBoardDomain] = useState('')
  const [board, setBoard] = useState<api.BoardEntry[] | null>(null)
  const [input, setInput] = useState('')
  const [err, setErr] = useState('')
  const [flash, setFlash] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(Date.now())
  // 主玩法与自由玩保持一致：默认问一问，判官不可用时回落猜词
  const [mode, setMode] = useState<'ask' | 'guess'>('ask')
  const [judgeReady, setJudgeReady] = useState(true)
  const clockRef = useRef({ now: 0, at: 0 })
  const timeoutSyncRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const apply = useCallback((s: api.ChallengeState) => {
    setSession(s)
    setJudgeReady(s.judgeReady !== false)
    clockRef.current = { now: s.now, at: Date.now() }
    setTick(Date.now())
    try {
      if (s.finished) localStorage.removeItem(SESSION_KEY)
      else localStorage.setItem(SESSION_KEY, s.id)
    } catch {
      /* 无痕模式忽略 */
    }
  }, [])

  // 首次进入拉领域列表；刷新页面时用本地存的 id 把未完成的挑战接回来
  useEffect(() => {
    let alive = true
    void api.challengeDomains()
      .then((d) => {
        if (!alive) return
        setDomains(d.domains)
        setRules(d.rules)
        setJudgeReady(d.judgeReady !== false)
        setBoardDomain((prev) => prev || d.domains[0]?.name || '')
      })
      .catch(() => { if (alive) setErr('领域列表加载失败，刷新页面试试') })
    try {
      const id = localStorage.getItem(SESSION_KEY)
      if (id) {
        void api.challengeSession(id)
          .then((s) => {
            if (!alive) return
            apply(s)
            setMode(s.judgeReady === false ? 'guess' : 'ask')
            setScreen('run')
          })
          .catch(() => localStorage.removeItem(SESSION_KEY))
      }
    } catch {
      /* ignore */
    }
    return () => { alive = false }
  }, [apply])

  useEffect(() => {
    if (screen !== 'board' || !boardDomain) return
    let alive = true
    setBoard(null)
    void api.challengeLeaderboard(boardDomain)
      .then((d) => { if (alive) setBoard(d.entries) })
      .catch(() => { if (alive) setBoard([]) })
    return () => { alive = false }
  }, [screen, boardDomain])

  // 倒计时用服务端时钟 + 本地单调递增的差值，避免用户改本机时间
  useEffect(() => {
    if (screen !== 'run' || session?.finished) return
    const t = window.setInterval(() => setTick(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [screen, session?.finished])

  const serverNow = clockRef.current.now + (tick - clockRef.current.at)
  const leftMs = session ? Math.max(0, session.deadline - serverNow) : 0

  // 时间一到主动找服务端同步一次，让超时由服务端判定并落定状态
  useEffect(() => {
    if (screen !== 'run' || !session || session.finished || leftMs > 0 || timeoutSyncRef.current || busy) return
    timeoutSyncRef.current = true
    void api.challengeSession(session.id).then(apply).catch(() => {})
  }, [screen, session, leftMs, busy, apply])

  const qLimit = rules?.questionLimit ?? 10
  const askOff = !judgeReady || qLimit === 0
  // 判官没配 / 管理员把问句额度设为 0 时自动回落到猜词，别让主玩法卡住玩家
  useEffect(() => {
    if (askOff && mode === 'ask') setMode('guess')
  }, [askOff, mode])

  const start = useCallback(async (domain: string) => {
    setErr('')
    setFlash('')
    setLoading(true)
    let delay = 800
    for (let i = 0; i < 20; i++) {
      try {
        const s = await api.challengeStart(domain, me)
        apply(s)
        setMode(s.judgeReady === false ? 'guess' : 'ask')
        timeoutSyncRef.current = false
        setInput('')
        setScreen('run')
        window.setTimeout(() => inputRef.current?.focus(), 150)
        setLoading(false)
        return
      } catch (e) {
        if ((e as { status?: number }).status !== 503) {
          setErr((e as Error).message || '开局失败，再试一次')
          break
        }
        setErr('引擎正在热身…')
        await new Promise((r) => window.setTimeout(r, delay))
        delay = Math.min(4000, delay * 1.4)
      }
    }
    setLoading(false)
  }, [apply, me])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!session || session.finished || !text || busy) return
    if (mode === 'ask' && askOff) return
    setBusy(true)
    setErr('')
    setFlash('')
    playTap()
    setInput('')
    // 判官要等模型回话，网络挂起时兜底解锁
    const guard = mode === 'ask' ? window.setTimeout(() => setBusy(false), 25000) : 0
    try {
      if (mode === 'ask') {
        const r = await api.challengeAsk(session.id, text)
        apply(r)
        const a = r.answer
        if (a?.dup) {
          playDup()
          setErr('这个问题问过了，换一个')
        } else if (a) {
          playTier(a.yes)
        }
      } else {
        const r = await api.challengeGuess(session.id, text)
        apply(r)
        const g = r.guess
        if (g?.dup) {
          playDup()
          setErr(`「${text}」这题猜过了，换一个`)
        } else if (g) {
          playTier(g.pct)
          if (g.exact && !r.finished) {
            setFlash(`第 ${g.level} 题蹭到了，下一题`)
            window.setTimeout(() => setFlash(''), 2200)
          }
          if (r.finished && r.result !== 'cleared') window.setTimeout(() => playLose(), 520)
        } else if (r.finished) {
          playLose()
        }
      }
    } catch (e) {
      setErr((e as Error).message || '网络开小差了')
    } finally {
      window.clearTimeout(guard)
      setBusy(false)
    }
  }

  async function abandon() {
    if (!session || session.finished || busy) return
    setBusy(true)
    try {
      apply(await api.challengeAbandon(session.id))
    } catch (e) {
      setErr((e as Error).message || '网络开小差了')
    } finally {
      setBusy(false)
    }
  }

  function openBoard(domain?: string) {
    if (domain) setBoardDomain(domain)
    setScreen('board')
  }

  function reset() {
    setSession(null)
    setInput('')
    setErr('')
    setFlash('')
    setScreen('pick')
    try { localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ }
  }

  const guesses = session?.guesses ?? []
  const questions = session?.questions ?? []
  const last = guesses.length ? guesses[guesses.length - 1] : null
  const lastQ = questions.length ? questions[questions.length - 1] : null
  const q = lastQ ? confOf(lastQ.yes) : null
  const pct = last?.pct ?? 0
  const temp = tempOf(pct)
  const sorted = useMemo(() => [...guesses].sort((a, b) => b.pct - a.pct), [guesses])
  const bestPct = sorted[0]?.pct ?? 0
  const qLeft = session ? Math.max(0, session.questionLimit - session.asked) : 0
  const gLeft = session ? Math.max(0, session.guessLimit - session.used) : 0
  const askFull = qLeft === 0
  const hintAfter = rules?.hintAfter ?? 3
  const hint = session?.hint
    ? `提示 · ${session.hint.chars} 个字`
    : `提示 · 再猜 ${Math.max(1, hintAfter - guesses.length)} 次给字数`
  const resultLine = session?.result === 'timeout'
    ? '时间到了，下次再快一点'
    : session?.result === 'exhausted' ? '猜词次数用完了' : '已放弃本次挑战'
  const disabled = !session || session.finished || busy || (mode === 'ask' && askFull)
  const placeholder = !session || session.finished
    ? '本次挑战已经结束'
    : mode === 'ask'
      ? askFull
        ? '是非题用完了，切到猜词收尾'
        : '问一个是非题，如：它是吃的吗？'
      : '想到答案了？输入这个词'

  return (
    <div className="challenge">
      {screen === 'pick' && (
        <div className="pick">
          <div className="pick-head">
            <h1>挑一个你最擅长的领域</h1>
            <p>相近的分类已经合并成 {domains.length} 个领域。先用是非题缩小范围，再用热度锁定答案；猜得越少、用得越快，排名越靠前。全部通关，你就是这一领域的专家。</p>
          </div>
          <div className="rules">
            <span><b>{rules?.levels ?? 4}</b> 道题</span>
            <span><b>{Math.round((rules?.timeLimitMs ?? 360000) / 60000)}</b> 分钟总时限</span>
            <span><b>{rules?.questionLimit ?? 10} 问 + {rules?.guessLimit ?? 30} 次</b> 额度</span>
          </div>
          <div className="rule-note">综合分 = 问与猜的总步数 × {rules?.perGuessSeconds ?? 30} + 用时秒数，越低越好</div>
          <div className="cat-grid">
            {domains.map((d) => (
              <button key={d.name} className="cat-btn" onClick={() => void start(d.name)} disabled={loading}>
                <b>{d.name}</b>
                <small className="grp">{d.groups.join(' · ')}</small>
                <small>{d.count} 词</small>
              </button>
            ))}
          </div>
          <div className="pick-foot">
            <button className="ghost" onClick={() => openBoard()}>看领域专家榜</button>
            {err && <span className="err-inline">{err}</span>}
          </div>
        </div>
      )}

      {screen === 'board' && (
        <div className="board">
          <div className="board-head">
            <button className="ghost" onClick={() => setScreen(session ? 'run' : 'pick')}>返回</button>
            <h2>领域专家榜</h2>
          </div>
          <div className="cat-tabs">
            {domains.map((d) => (
              <button key={d.name} className={boardDomain === d.name ? 'on' : ''} onClick={() => setBoardDomain(d.name)}>
                {d.name}
              </button>
            ))}
          </div>
          <div className="board-note">只记通关成绩 · 按综合分从低到高 · 每人保留最好一次</div>
          <ol className="board-list">
            {board === null ? (
              <li className="board-empty">加载中…</li>
            ) : board.length ? (
              board.map((e) => (
                <li key={e.playerId} className={e.playerId === me.id ? 'me' : ''}>
                  <span className="rk">{e.rank}</span>
                  <span className="nm">{e.name}</span>
                  <span className="st">{e.used} 次 · {clock(e.seconds * 1000)}</span>
                  <span className="sc">{e.score}</span>
                </li>
              ))
            ) : (
              <li className="board-empty">这个领域还没有人通关，快来占个坑</li>
            )}
          </ol>
        </div>
      )}

      {screen === 'run' && session && (
        <>
          <div className="run-head">
            <span className="run-cat">{session.category} · 第 {session.level}/{session.total} 题</span>
            <span className="hud">
              <span className={leftMs < 60_000 ? 'urgent' : ''}>{clock(leftMs)}</span>
              <span>还剩 <b>{qLeft}</b> 问</span>
              <span><b>{gLeft}</b> 次</span>
            </span>
          </div>
          <div className="steps">
            {session.levels.map((l, i) => (
              <div key={i} className={`step ${l.state}`}>{l.state === 'cleared' ? l.answer : i + 1}</div>
            ))}
          </div>

          {/* 主玩法问一问在左且默认选中；判官不可用时禁用并回落猜词 */}
          <div className="modes" role="tablist">
            <button
              className={mode === 'ask' ? 'mode-btn main on' : 'mode-btn main'}
              onClick={() => setMode('ask')}
              role="tab"
              aria-selected={mode === 'ask'}
              disabled={askOff}
              title={askOff ? '判官未配置（需要 TYPESAFE_API_KEY）' : '主玩法：用是非题逼近答案'}
            >
              问一句<em>{qLeft} 问</em>
            </button>
            <button
              className={mode === 'guess' ? 'mode-btn on' : 'mode-btn'}
              onClick={() => setMode('guess')}
              role="tab"
              aria-selected={mode === 'guess'}
              title="想到答案了？用热度锁定"
            >
              猜词<em>{gLeft} 次</em>
            </button>
          </div>

          <section className={`gauge ${mode === 'ask' ? 'ask' : ''}`}>
            {mode === 'ask' ? (
              <>
                <div className={`num ${q?.yes ? 'q-yes' : 'q-no'}`}>{q ? (q.yes ? '是' : '否') : '?'}</div>
                <div className="verdict">
                  <b>{q ? `${q.conf}% 把握` : '问一个是非题'}</b>
                  <span>{q ? `「${lastQ?.q}」` : '判官会回答是或否'}</span>
                </div>
              </>
            ) : (
              <>
                <div className="num">
                  {last ? pct : '?'}<span className="unit">/ 100</span>
                </div>
                <div className="verdict">
                  <b>{last ? temp.label : '猜一个词'}</b>
                  <span>{last ? `「${last.word}」` : '越靠近答案，热度越高'}</span>
                </div>
              </>
            )}
            <div className="thermo">
              <div
                className="fill"
                style={{
                  width: `${mode === 'ask' ? Math.max(2, q?.conf ?? 0) : Math.max(2, pct)}%`,
                  background: mode === 'ask' ? (q?.yes ? '#74c9ad' : '#7f8ba3') : `hsl(${temp.hue} 90% 64%)`,
                }}
              />
            </div>
            <div className="chips">
              <span className={`chip cat ${session.hint ? 'unlocked' : ''} ${flash ? 'flash' : ''}`}>{flash || hint}</span>
            </div>
          </section>

          <section className="history">
            <div className="hhead">
              <span>第 {session.level} 题 · {mode === 'ask' ? '问过的是非题' : '猜过的词'}</span>
              <span className="hsub">
                {mode === 'ask'
                  ? `还剩 ${qLeft} 问`
                  : guesses.length ? `最热 ${bestPct}` : '按热度排'}
              </span>
            </div>
            {mode === 'ask' ? (
              questions.length ? (
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
                <div className="empty">问过的问题和判官的回答会记在这里，问得差不多就切到猜词收尾</div>
              )
            ) : guesses.length ? (
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
              <div className="empty">猜过的词和热度记在这里，蹭到 100 就自动进入下一题</div>
            )}
          </section>

          <form className="entry" onSubmit={(e) => void submit(e)}>
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
            <button className="ghost" onClick={() => void abandon()} disabled={session.finished || busy}>放弃本次</button>
            <button className="ghost" onClick={() => openBoard(session.category)}>排行榜</button>
          </footer>

          {session.finished && (
            <div className="overlay">
              <div className="panel result-panel">
                <div className={`verdict-badge ${session.result === 'cleared' ? 'win' : 'lose'}`}>
                  {session.result === 'cleared' ? `${session.category} · 领域专家` : '挑战结束'}
                </div>
                <div className="answer">{session.index} / {session.total}</div>
                <div className="sub">
                  {session.result === 'cleared'
                    ? `问了 ${session.asked} 问 · 猜了 ${session.used} 次 · 用时 ${clock(session.elapsedMs)} · 榜单第 ${session.rank} 名`
                    : `${resultLine} · 问了 ${session.asked} 问 · 猜了 ${session.used} 次`}
                </div>
                <div className="score-line">
                  综合分 {session.score ?? '—'}
                  <span>步数（问 + 猜）× {session.rules.perGuessSeconds} + 用时秒数，越低越好</span>
                </div>
                <div className="answers">
                  {session.levels.map((l, i) => (
                    <span key={i} className={l.state === 'cleared' ? 'ok' : ''}>{l.answer ?? '???'}</span>
                  ))}
                </div>
                <div className="panel-actions">
                  <button className="primary" onClick={() => void start(session.category)}>再挑战一次</button>
                  <div className="panel-links">
                    <button className="ghost" onClick={() => openBoard(session.category)}>看排行榜</button>
                    <button className="ghost" onClick={reset}>换个领域</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
