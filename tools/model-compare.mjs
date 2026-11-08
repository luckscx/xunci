// 对比不同模型在同一组"从近到远"词上的分辨力
import { pipeline } from '@huggingface/transformers'

const MODELS = [
  ['Xenova/bge-small-zh-v1.5', 'fp32'],
  ['Xenova/bge-base-zh-v1.5', 'q8'],
  ['Xenova/bge-large-zh-v1.5', 'q8'],
]

const CASES = [
  ['篮球', ['篮筐', '篮球鞋', '篮板', '球', '球场', '排球', '足球', '乒乓球', '比赛', '运动', '跑步', '汽车']],
  ['医院', ['诊所', '病房', '住院', '医生', '看病', '护士', '手术', '药', '学校', '汽车']],
  ['钢琴', ['钢琴家', '琴键', '小提琴', '吉他', '乐器', '音乐', '演奏', '汽车']],
]

const REF = `汽车 天空 面包 法律 医院 跑步 金属 儿童 钱包 森林 桌子 手机 咖啡 电梯 沙发 眼镜 火车 银行 婚礼 图书馆
雨伞 铅笔 毛巾 冰箱 皮鞋 窗帘 词典 篮球 沙漠 月球 海洋 厨房 教室 办公室 超市 机场 公园 博物馆
电影 新闻 工资 合同 会议 旅行 生日 春节 周末 早晨 冬天 台风 雾 雪 阳光 彩虹 影子 父亲 老师 学生 警察`
  .split(/\s+/)
  .filter(Boolean)

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }

for (const [id, dtype] of MODELS) {
  let ex
  try {
    ex = await pipeline('feature-extraction', id, { dtype })
  } catch (e) {
    console.log('\n', id, '加载失败:', e.message.slice(0, 80))
    continue
  }
  const cache = new Map()
  const vec = async (t) => {
    if (cache.has(t)) return cache.get(t)
    const out = await ex(t, { pooling: 'cls', normalize: true })
    cache.set(t, out.data)
    return out.data
  }
  const t0 = Date.now()
  console.log(`\n===== ${id} (${dtype})`)
  for (const [target, words] of CASES) {
    const tv = await vec(target)
    const refs = []
    for (const r of REF) refs.push(await vec(r))
    const base = refs.reduce((s, rv) => s + cos(tv, rv), 0) / refs.length
    const rows = []
    for (const w of words) rows.push([w, cos(tv, await vec(w))])
    // 相邻档位之间的差值，越大说明分辨力越好
    const gaps = []
    for (let i = 1; i < rows.length - 1; i++) gaps.push(+(rows[i][1] - rows[i + 1][1]).toFixed(3))
    console.log(`目标 ${target} baseline=${base.toFixed(3)}`)
    console.log('  ', rows.map(([w, c]) => `${w}:${c.toFixed(3)}`).join('  '))
    console.log('   相邻差值:', gaps.join(' '), ' 最大差', Math.max(...gaps).toFixed(3))
  }
  console.log('  耗时', Date.now() - t0, 'ms')
}
