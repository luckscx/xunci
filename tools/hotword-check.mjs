// 判断一个热词能不能当"答案"：用几个语义上应该相关的普通词去猜它，看能不能蹭到热度
import { init, embedWord, baseline, score } from '../server/embedder.js'

await init()
const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

const TABLE = [
  ['内卷', ['竞争', '加班', '压力']],
  ['打工人', ['上班', '员工', '辛苦']],
  ['摸鱼', ['偷懒', '上班', '休息']],
  ['破防', ['崩溃', '难过', '感动']],
  ['躺平', ['放弃', '休息', '不努力']],
  ['松弛感', ['放松', '从容', '淡定']],
  ['情绪价值', ['安慰', '陪伴', '开心']],
  ['边界感', ['界限', '距离', '尊重']],
  ['主理人', ['老板', '店主', '管理']],
  ['邪修', ['修炼', '修仙', '偏门']],
  ['活人感', ['真实', '自然', '真诚']],
  ['数字游民', ['旅行', '远程', '自由']],
  ['谷子', ['周边', '动漫', '收藏']],
  ['苏超', ['足球', '联赛', '江苏']],
  ['具身智能', ['机器人', '人工智能', '身体']],
  ['班味', ['上班', '加班', '疲惫']],
  ['显眼包', ['出风头', '搞笑', '张扬']],
  ['搭子', ['朋友', '陪伴', '伙伴']],
  ['嘴替', ['说话', '表达', '代言']],
  ['社恐', ['社交', '害羞', '内向']],
  ['牛马', ['苦力', '打工', '辛苦']],
  ['凡尔赛', ['炫耀', '吹牛', '装']],
  ['电子榨菜', ['视频', '下饭', '娱乐']],
  ['爱你老己', ['自己', '爱', '心疼']],
  ['丝瓜汤', ['汤', '蔬菜', '妈妈']],
  ['养龙虾', ['人工智能', '训练', '智能']],
  ['夯爆了', ['厉害', '爆炸', '火爆']],
  ['大抽象', ['荒诞', '搞笑', '抽象']],
  ['敬自己一杯', ['干杯', '自己', '喝酒']],
  ['酱板鸭', ['鸭子', '食物', '湖南']],
  ['背手负鼠', ['动物', '负鼠', '老鼠']],
  ['精神中国人', ['中国', '文化', '认同']],
  ['数字泔水', ['垃圾', '信息', '内容']],
  ['向上社交', ['交际', '人脉', '社交']],
  ['从从容容', ['从容', '淡定', '悠闲']],
  ['赛博对账', ['互联网', '数字', '账本']],
]

console.log('热词'.padEnd(14), '最高', ' 最相关的普通词（热度）')
const rows = []
for (const [word, anchors] of TABLE) {
  const tv = await embedWord(word)
  const base = await baseline(tv)
  const scored = []
  for (const a of anchors) {
    const av = await embedWord(a)
    scored.push({ a, heat: score(cos(tv, av), base) })
  }
  scored.sort((x, y) => y.heat - x.heat)
  rows.push({ word, best: scored[0].heat, anchors: scored })
  console.log(
    word.padEnd(14),
    String(scored[0].heat).padStart(3),
    ' ',
    scored.map((s) => `${s.a}:${s.heat}`).join(' '),
  )
}

const keep = rows.filter((r) => r.best >= 30).map((r) => r.word)
const drop = rows.filter((r) => r.best < 30).map((r) => r.word)
console.log('\n可用（≥30 热度）:', keep.join(' '))
console.log('模型不认识 / 不建议:', drop.join(' '))
