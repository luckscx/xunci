// 模拟真人猜测路径：每个目标给一串"玩家真会想到的词"，看热度阶梯断在哪
import { init, embedWord, baseline, overlap, score } from '../server/embedder.js'

await init()
const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

const CASES = {
  篮球: ['运动', '比赛', '足球', '排球', '乒乓球', '球', '球场', '篮筐', '篮球鞋', '运动员'],
  钢琴: ['音乐', '乐器', '吉他', '小提琴', '琴键', '弹奏', '贝多芬', '鼓', '曲子', '钢琴家'],
  火锅: ['食物', '吃', '烧烤', '辣椒', '汤', '锅', '牛油', '涮羊肉', '麻辣', '聚餐'],
  医院: ['生病', '医生', '护士', '看病', '药', '手术', '病房', '救护车', '挂号', '病床'],
  企鹅: ['动物', '鸟', '鸭子', '南极', '海豹', '北极熊', '翅膀', '企鹅', '海洋', '冰'],
  玫瑰: ['花', '月季', '爱情', '情人节', '刺', '香味', '花店', '红色', '植物', '玫瑰'],
  彩虹: ['雨', '天空', '颜色', '七色', '太阳', '光学', '半圆', '桥', '彩虹'],
  猫: ['动物', '宠物', '狗', '老鼠', '喵', '爪子', '猫粮', '猫咪', '老虎', '毛'],
}

for (const [target, guesses] of Object.entries(CASES)) {
  const tv = await embedWord(target)
  const base = await baseline(tv)
  const rows = guesses.map((g) => {
    const raw = cos(tv, null ?? 0) // placeholder replaced below
    return { g }
  })
  const scored = []
  for (const g of guesses) {
    const gv = await embedWord(g)
    const raw = cos(tv, gv)
    const pct = g === target ? 100 : Math.min(99, score(raw, base, overlap(target, g)))
    scored.push({ g, pct, raw })
  }
  const line = scored.map((r) => `${r.g} ${r.pct}`).join(' · ')
  const sorted = [...scored].sort((a, b) => a.pct - b.pct)
  const mid = sorted.filter((r) => r.pct > 65 && r.pct < 85).length
  const hot = sorted.filter((r) => r.pct >= 85).length
  console.log(`\n${target}: ${line}`)
  console.log(`   落在 66-84（"差一层"区间）的词数: ${mid} / ${scored.length}；落在 85+ 的: ${hot}`)
}
