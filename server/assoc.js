// 关联词典的运行时：把 assoc-data.js 里的字符串解析成 词 → 热度 的表，并做启动期校验。
//
// 为什么需要它：bge-small 对"含字/组合词"很准（篮球→篮球鞋 96），但对常识关联几乎是瞎的
// （企鹅→南极 4、玫瑰→月季 7、彩虹→雨 7）。玩家照着最自然的联想猜，却得到"没蹭到"。
// 这张表是作者手工分层的补丁：表里有的词直接给作者定的热度，表里没有的才回落到向量算。
//
// 数据格式（assoc-data.js）：'邻居 热度 邻居 热度 ...'，空格分隔，成对出现。
import { ASSOC_DATA } from './assoc-data.js'

const TABLE = new Map()

for (const [target, spec] of Object.entries(ASSOC_DATA)) {
  if (target === '__end__') continue
  if (typeof spec !== 'string') throw new Error(`assoc: ${target} 的值必须是字符串`)
  const parts = spec.trim().split(/\s+/)
  if (parts.length % 2 !== 0) throw new Error(`assoc: ${target} 的词/热度没有成对：${spec.slice(0, 40)}`)
  const m = new Map()
  for (let i = 0; i < parts.length; i += 2) {
    const w = parts[i]
    const heat = Number(parts[i + 1])
    if (!w) throw new Error(`assoc: ${target} 有空词`)
    if (w === target) throw new Error(`assoc: ${target} 的邻居里出现了答案本身`)
    if (!Number.isInteger(heat) || heat < 1 || heat > 99) {
      throw new Error(`assoc: ${target} → ${w} 的热度 ${parts[i + 1]} 不是 1..99 的整数`)
    }
    if (m.has(w)) throw new Error(`assoc: ${target} → ${w} 重复出现`)
    m.set(w, heat)
  }
  TABLE.set(target, m)
}

/** 目标词的关联词典：Map<猜的词, 热度>，没有就是 null */
export function assocOf(target) {
  return TABLE.get(target) || null
}

/** 统计信息：给校验脚本和管理页用 */
export function assocStats() {
  let pairs = 0
  for (const m of TABLE.values()) pairs += m.size
  return { targets: TABLE.size, pairs, words: [...TABLE.keys()] }
}
