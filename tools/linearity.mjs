// 对比：纯余弦 vs 加了字面重叠后的热度梯度
import { init, embedWord, baseline, overlap, score } from '../server/embedder.js'

await init()
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }

const CASES = [
  ['篮球', ['篮筐', '篮球鞋', '篮板', '球衣', '球', '球场', '乒乓球', '排球', '足球', '运动会', '比赛', '运动员', '体育馆', '运动', '跑步', '汽车']],
  ['医院', ['诊所', '住院', '病房', '医生', '看病', '护士', '手术', '药', '学校', '汽车']],
  ['钢琴', ['钢琴家', '琴键', '小提琴', '吉他', '乐器', '音乐', '演奏', '汽车']],
  ['西瓜', ['西瓜汁', '甜瓜', '南瓜', '水果', '苹果', '夏天', '沙拉', '汽车']],
]

for (const [target, words] of CASES) {
  const tv = await embedWord(target)
  const base = await baseline(tv)
  console.log(`\n目标「${target}」`)
  console.log('  词'.padEnd(12), '旧热度', ' 新热度', ' 变化')
  for (const w of words) {
    const raw = cos(tv, await embedWord(w))
    const old = score(raw, base)
    const ov = overlap(target, w)
    const now = score(raw, base, ov)
    const d = now - old
    console.log('  ' + w.padEnd(10), String(old).padStart(6), String(now).padStart(7), (d > 0 ? '+' + d : String(d)).padStart(6), ov ? ` (含${Math.round(ov * 100)}%答案的字)` : '')
  }
}
