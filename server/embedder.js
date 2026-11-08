import { pipeline } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/bge-small-zh-v1.5'
const DTYPE = 'fp32'

let extractor = null
let ready = null

// 常见中文参照词，用于估计"目标词 vs 随便一个词"的平均相似度，
// 作为归一化基准：平均水平的词应当显示 0% 左右。
const REF_WORDS = `汽车 天空 面包 法律 医院 跑步 金属 儿童 钱包 森林 桌子 手机 咖啡 电梯 沙发 眼镜 火车 银行 婚礼 图书馆
雨伞 铅笔 毛巾 冰箱 火车 皮鞋 窗帘 词典 钢琴 篮球 沙漠 月球 海洋 厨房 教室 办公室 超市 机场 公园 博物馆
电影 新闻 工资 合同 会议 旅行 生日 婚礼 春节 周末 早晨 中午 冬天 夏夜 台风 雾 雪 阳光 彩虹 影子
父亲 母亲 哥哥 姐姐 老师 学生 医生 警察 司机 厨师 农民 士兵 演员 画家 作家 记者 律师 会计 快递 保安
愤怒 快乐 悲伤 焦虑 孤独 好奇 勇敢 温柔 尴尬 后悔 期待 无聊 骄傲 同情 恐惧 疲惫 兴奋 平静 羞愧 嫉妒
电脑 软件 网络 数据 算法 芯片 电池 摄像头 键盘 打印机 服务器 密码 充电 屏幕 耳机 信号 程序 文件 备份
足球 游泳 跑步 羽毛球 乒乓球 瑜伽 健身 滑雪 拳击 排球 潜水 攀岩 马拉松 骑行 体操 钓鱼 蹦极 射箭
钢琴 吉他 小提琴 鼓 二胡 笛子 旋律 节奏 合唱 摇滚 民谣 交响乐 舞台 录音 歌词 节拍 演唱
早餐 午餐 晚餐 米饭 面条 馒头 豆浆 火锅 烤肉 沙拉 蛋糕 巧克力 冰淇淋 啤酒 咖啡 茶 粥 饺子 花生
钥匙 钉子 绳子 胶带 剪刀 水桶 梯子 电池 灯泡 开关 插座 窗帘 抽屉 衣柜 地毯 镜子 花瓶 相框 垃圾桶`
  .split(/\s+/)
  .filter((w) => /^[\u4e00-\u9fa5]{2}$/.test(w))

// 实测：单字词加 BGE 检索前缀会显著压缩区分度（无关词也被推到 0.8+），故不加前缀
const PREFIX = ''

const vecCache = new Map()
const CACHE_MAX = 8000

function cosine(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

async function encodeMany(texts) {
  const out = await extractor(texts, { pooling: 'cls', normalize: true })
  const dim = out.dims[out.dims.length - 1]
  const flat = out.data
  const res = []
  for (let i = 0; i < texts.length; i++) res.push(flat.slice(i * dim, (i + 1) * dim))
  return res
}

export async function init() {
  if (ready) return ready
  ready = (async () => {
    extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: DTYPE })
    // 预热 + 计算参照基准向量
    const refVecs = await encodeMany(REF_WORDS.map((w) => PREFIX + w))
    REF_VECS.push(...refVecs)
    await encodeMany([PREFIX + '西瓜'])
  })()
  return ready
}

const REF_VECS = []

export function isReady() {
  return extractor !== null && REF_VECS.length > 0
}

export async function embedWord(word) {
  const key = word
  const hit = vecCache.get(key)
  if (hit) return hit
  const [v] = await encodeMany([PREFIX + word])
  if (vecCache.size > CACHE_MAX) {
    const first = vecCache.keys().next().value
    vecCache.delete(first)
  }
  vecCache.set(key, v)
  return v
}

/** 目标词与参照词的平均相似度，衡量该词的"hubness" */
export async function baseline(targetVec) {
  let sum = 0
  for (const v of REF_VECS) sum += cosine(targetVec, v)
  const mean = sum / REF_VECS.length
  return mean
}

/** 字面重叠：猜的词里含多少个答案的字（按答案字数归一化） */
export function overlap(target, guess) {
  if (target === guess) return 1
  const t = new Set([...target])
  let hit = 0
  for (const ch of new Set([...guess])) if (t.has(ch)) hit++
  return hit / t.size
}

/**
 * 关联度百分比：以"平均随机词"为 0 点做归一化，
 * 再开方拉伸低分区间，让 0-20% 段有可见梯度。
 *
 * ov 是字面重叠系数：纯余弦只能表达"同一个话题"，分不清
 * 「篮球鞋」(包含答案) 和「排球」(同类词)。叠一层字面重叠后，
 * 带答案字的词会明确跳到高位，玩家的"爬升"才有落点。
 */
export function score(raw, base, ov = 0) {
  const boosted = Math.min(0.9, raw + 0.1 * ov)
  if (boosted >= 0.999) return 100
  // 冷区：与"随便一个词"的相似度持平或更低，只给 0-8 的微梯度
  const coldTop = base + 0.09
  if (boosted <= coldTop) {
    const x = Math.min(1, Math.max(0, (boosted - (base - 0.13)) / 0.22))
    return Math.round(8 * x)
  }
  // 温区：8 → 100
  const hi = 0.92
  const x = Math.min(1, Math.max(0, (boosted - coldTop) / (hi - coldTop)))
  return Math.round(8 + 92 * Math.pow(x, 0.62))
}
