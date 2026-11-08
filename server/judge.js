// 是非题判官：用 @typesafe-ai/sdk 的 systemOne 判决玩家的是非题。
// 判官看到真实答案，noul() 返回"是"的概率（0-1），换算成 0-100 给前端。
//
// 环境变量：
//   TYPESAFE_API_KEY  TypeSafe 平台的 key（不配则是非题模式提示未配置）
//   TYPESAFE_MODEL    可选，默认 jev-latest

import { noul, TypeSafeClient } from '@typesafe-ai/sdk'

const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest'

export const judgeConfigured = () => Boolean(process.env.TYPESAFE_API_KEY)

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
