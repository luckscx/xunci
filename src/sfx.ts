// 全部用 Web Audio 现场合成，不加载任何音频文件
const KEY = 'xunci.sound.v1'

let ctx: AudioContext | null = null
let master: GainNode | null = null

export function isMuted(): boolean {
  return localStorage.getItem(KEY) === '1'
}

export function setMuted(m: boolean) {
  localStorage.setItem(KEY, m ? '1' : '0')
  if (m && ctx) void ctx.suspend()
  else if (!m && ctx) void ctx.resume()
}

function engine() {
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.85
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return { ctx, out: master as GainNode }
}

type Note = {
  f: number
  t: number
  d: number
  type?: OscillatorType
  g?: number
  to?: number
}

function play(notes: Note[]) {
  if (isMuted()) return
  const { ctx, out } = engine()
  const t0 = ctx.currentTime + 0.01
  for (const n of notes) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = n.type ?? 'sine'
    osc.frequency.setValueAtTime(n.f, t0 + n.t)
    if (n.to) osc.frequency.exponentialRampToValueAtTime(Math.max(40, n.to), t0 + n.t + n.d * 0.92)
    const peak = n.g ?? 0.11
    gain.gain.setValueAtTime(0.0001, t0 + n.t)
    gain.gain.exponentialRampToValueAtTime(peak, t0 + n.t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.d)
    osc.connect(gain)
    gain.connect(out)
    osc.start(t0 + n.t)
    osc.stop(t0 + n.t + n.d + 0.03)
  }
}

/** 短促的电流噪声，用来做"嘀嗒"火花 */
function spark(t: number, d = 0.06, g = 0.05, hp = 2600) {
  if (isMuted()) return
  const { ctx, out } = engine()
  const len = Math.max(1, Math.floor(ctx.sampleRate * d))
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
  const src = ctx.createBufferSource()
  src.buffer = buf
  const filter = ctx.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = hp
  const gain = ctx.createGain()
  gain.gain.value = g
  src.connect(filter)
  filter.connect(gain)
  gain.connect(out)
  src.start(ctx.currentTime + t)
}

/** 按下"蹭一下"：短促的电流声 */
export function playTap() {
  play([{ f: 1180, t: 0, d: 0.05, type: 'square', g: 0.045, to: 760 }])
}

/** 重复猜同一个词 */
export function playDup() {
  play([
    { f: 300, t: 0, d: 0.07, type: 'square', g: 0.05 },
    { f: 240, t: 0.09, d: 0.09, type: 'square', g: 0.05 },
  ])
}

/** 按热度分段给不同动机 */
export function playTier(pct: number) {
  if (pct >= 100) {
    // 蹭到了：大三和弦上行 + 高音闪光
    play([
      { f: 523.25, t: 0, d: 0.16, type: 'triangle', g: 0.1 },
      { f: 659.25, t: 0.09, d: 0.16, type: 'triangle', g: 0.1 },
      { f: 783.99, t: 0.18, d: 0.2, type: 'triangle', g: 0.11 },
      { f: 1046.5, t: 0.27, d: 0.5, type: 'sine', g: 0.13 },
      { f: 1567.98, t: 0.3, d: 0.4, type: 'sine', g: 0.05 },
    ])
    spark(0.28, 0.16, 0.05, 3200)
    return
  }
  if (pct >= 95) {
    // 烫到极限：极近的高音三连，带一点颤
    play([
      { f: 1046.5, t: 0, d: 0.09, type: 'square', g: 0.055 },
      { f: 1318.5, t: 0.1, d: 0.09, type: 'square', g: 0.055 },
      { f: 1568, t: 0.2, d: 0.18, type: 'triangle', g: 0.1 },
      { f: 1592, t: 0.2, d: 0.18, type: 'sine', g: 0.05 },
    ])
    spark(0.2, 0.12, 0.04, 3400)
    return
  }
  if (pct >= 81) {
    play([
      { f: 659.25, t: 0, d: 0.1, type: 'triangle', g: 0.09 },
      { f: 830.6, t: 0.08, d: 0.1, type: 'triangle', g: 0.09 },
      { f: 987.77, t: 0.16, d: 0.16, type: 'triangle', g: 0.1 },
    ])
    spark(0.16, 0.08, 0.03)
    return
  }
  if (pct >= 66) {
    play([
      { f: 587.33, t: 0, d: 0.1, type: 'triangle', g: 0.09 },
      { f: 739.99, t: 0.07, d: 0.1, type: 'triangle', g: 0.09 },
      { f: 880, t: 0.14, d: 0.14, type: 'triangle', g: 0.09 },
    ])
    return
  }
  if (pct >= 51) {
    play([
      { f: 523.25, t: 0, d: 0.1, type: 'triangle', g: 0.085 },
      { f: 659.25, t: 0.08, d: 0.14, type: 'triangle', g: 0.085 },
    ])
    return
  }
  if (pct >= 36) {
    play([
      { f: 440, t: 0, d: 0.1, type: 'triangle', g: 0.08 },
      { f: 554.37, t: 0.08, d: 0.14, type: 'triangle', g: 0.08 },
    ])
    return
  }
  if (pct >= 21) {
    play([{ f: 392, t: 0, d: 0.16, type: 'triangle', g: 0.075, to: 466.16 }])
    return
  }
  if (pct > 8) {
    // 凉：单音下坠
    play([{ f: 330, t: 0, d: 0.14, type: 'sine', g: 0.07, to: 262 }])
    return
  }
  // 没蹭到：闷闷的一声低频
  play([
    { f: 220, t: 0, d: 0.16, type: 'sine', g: 0.08, to: 146.83 },
    { f: 110, t: 0, d: 0.18, type: 'sine', g: 0.05 },
  ])
}

/** 机会用尽 */
export function playLose() {
  play([
    { f: 392, t: 0, d: 0.16, type: 'triangle', g: 0.08 },
    { f: 311.13, t: 0.14, d: 0.16, type: 'triangle', g: 0.08 },
    { f: 233.08, t: 0.28, d: 0.34, type: 'sine', g: 0.09 },
  ])
}
