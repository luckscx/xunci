// 是非题判官：用 @typesafe-ai/sdk 的 systemOne 判决玩家的是非题。
// 判官看到真实答案，noul() 返回"是"的概率（0-1），换算成 0-100 给前端。
//
// 环境变量：
//   TYPESAFE_API_KEY  TypeSafe 平台的 key（不配则是非题模式提示未配置）
//   TYPESAFE_MODEL    可选，默认 jev-latest

import { readFileSync } from 'node:fs'
import { noul, TypeSafeClient } from '@typesafe-ai/sdk'

// 兜底加载项目根目录的 .env：不依赖 --env-file 启动参数，忘了带 flag 也能读到 key。
// 真实环境变量优先（已存在的变量不覆盖），兼容 CRLF 行尾和带引号的值。
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}

const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest'

export const judgeConfigured = () => Boolean(process.env.TYPESAFE_API_KEY)

/** 是非题保留标点（问句要通顺），只折叠空白 */
export const normQ = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40)

/** 是非题入参校验，通过返回归一化问句，否则返回错误文案；房间与闯关共用 */
export function checkAsk(raw) {
  const q = normQ(raw)
  if (q.length < 2) return { error: '问题太短了，比如「它是吃的吗？」' }
  if (!/[\u4e00-\u9fa5]/.test(q)) return { error: '请用中文提问' }
  if (!/[吗呢么?？]$/.test(q)) return { error: '请问一个是非题（以「吗/呢/?」结尾）' }
  if (!judgeConfigured()) return { error: '是非题判官还没配置（需要 TYPESAFE_API_KEY）' }
  return { q }
}

let client = null
function getClient() {
  if (!client) client = new TypeSafeClient({ defaultModel: MODEL })
  return client
}

/** @returns {Promise<number>} "是"的概率 0-100 */
export async function askJudge(question, target, category) {
  const { answers } = await getClient().systemOne({
    // 答案只在这里出现，判官依据它的事实回答，但回复里不泄露字面
    state: {
      game: '猜词游戏：玩家看不到答案，正在用是非题逼近答案',
      category,
      answer: target,
    },
    questions: {
      verdict: noul(
        `玩家的问题：「${question}」。严格以答案的客观事实为准，输出"是"的可能性；说不好的事实给接近 0.5 的值。`,
        {
          true: '答案确实具备问题所说的性质',
          false: '不具备，或问题对答案不成立',
        },
      ),
    },
  })
  const p = answers.verdict.noul
  if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error('judge bad output')
  return Math.min(100, Math.max(0, Math.round(p * 100)))
}
