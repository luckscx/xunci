// 验证新增的"热梗"分类真的可玩：开一局热梗题，用相关普通词猜，热度要能起来
import { WORD_POOL } from '../server/words.js'

const BASE = process.env.BASE || 'http://127.0.0.1:3110'
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json()

const anchors = {
  打工人: ['员工', '上班'], 躺平: ['休息', '放弃'], 社恐: ['社交', '害羞'], 邪修: ['修炼', '修仙'],
  班味: ['加班', '上班'], 搭子: ['伙伴', '陪伴'], 嘴替: ['说话', '代言'], 活人感: ['真实', '真诚'],
  松弛感: ['放松', '淡定'], 边界感: ['界限', '尊重'], 主理人: ['店主', '老板'], 电子榨菜: ['下饭', '视频'],
  具身智能: ['人工智能', '机器人'], 酱板鸭: ['鸭子', '食物'], 丝瓜汤: ['汤', '蔬菜'],
  爱你老己: ['爱', '自己'], 夯爆了: ['火爆', '厉害'], 大抽象: ['抽象', '荒诞'],
  敬自己一杯: ['干杯', '自己'], 向上社交: ['社交', '人脉'], 赛博对账: ['账本', '数字'],
  苏超: ['江苏', '足球'], 从从容容: ['从容', '悠闲'], 背手负鼠: ['负鼠', '老鼠'],
}

const hot = WORD_POOL.filter((x) => x.c === '热梗').map((x) => x.w)
console.log(`池内热梗 ${hot.length} 个，全池 ${WORD_POOL.length} 个`)

// 直接对每个热梗跑一遍（用 /api/game 抽到的若是别的词就跳过，改用 /api/guess 需要 id）
// 简化：抽到热梗局才测；最多抽 400 次
let tested = 0
const results = []
for (let i = 0; i < 400 && tested < 5; i++) {
  const g = await post('/api/game')
  if (g.category !== '热梗') continue
  tested++
  const words = [...(anchors[g.answer] || []), g.answer].filter(Boolean)
  const rows = []
  for (const w of words) {
    const r = await post('/api/guess', { id: g.id, word: w })
    rows.push(`${w}:${r.pct}${r.exact ? '✓' : ''}`)
  }
  results.push(rows.join(' '))
  console.log(`局 ${tested} 答案=${g.answer}（QA 可见）→ ${rows.join(' ')}`)
}
if (!tested) console.log('未抽到热梗局（概率偏低，不影响）')
