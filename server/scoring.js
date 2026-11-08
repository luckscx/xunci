// 猜词打分：公共房间对局和闯关模式共用，保证两个模式的热度口径完全一致。
import { embedWord, baseline, overlap, score } from './embedder.js'
import { assocOf } from './assoc.js'

const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** 每个目标词只算一次参照基准，房间与闯关共享缓存 */
const baseCache = new Map()

export async function targetBaseline(word) {
  if (baseCache.has(word)) return baseCache.get(word)
  const v = await embedWord(word)
  const b = await baseline(v)
  baseCache.set(word, b)
  return b
}

/**
 * 关联词典优先（作者分层的邻居直接给热度），表里没有的词才回落向量算。
 * 返回 0..100；100 只可能是精确命中，非精确命中最高 99。
 */
export async function rateGuess(target, base, word) {
  const exact = word === target
  if (exact) return 100
  const authored = assocOf(target)?.get(word)
  if (authored != null) return Math.min(99, authored)
  const tv = await embedWord(target)
  const gv = await embedWord(word)
  return Math.min(99, score(cos(tv, gv), base, overlap(target, word)))
}
