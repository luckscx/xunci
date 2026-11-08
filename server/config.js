import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'data', 'config.json')

/** 全局可调配置（管理页修改后立即生效并落盘，重启不丢） */
export const config = {
  /** 向量近似度猜词次数上限 */
  attempts: 30,
  /** 每局是非题（问一问）次数上限 */
  questions: 10,
  /** 是否允许「放弃，看答案」 */
  allowReveal: true,
  /** 是否开启分类提示 */
  categoryHint: true,
  /** 猜满多少次后解锁分类提示 */
  categoryAt: 10,
}

const LIMITS = {
  attempts: [1, 200],
  questions: [0, 50],
  categoryAt: [0, 200],
}

const clamp = (n, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(Number(n))))

/** 启动时读回上次保存的配置；坏文件/缺字段都回落默认值 */
export function loadConfig() {
  try {
    const saved = JSON.parse(readFileSync(FILE, 'utf8'))
    if (saved && typeof saved === 'object') {
      for (const k of ['attempts', 'questions', 'categoryAt']) {
        if (Number.isFinite(Number(saved[k]))) config[k] = clamp(saved[k], LIMITS[k])
      }
      if (typeof saved.allowReveal === 'boolean') config.allowReveal = saved.allowReveal
      if (typeof saved.categoryHint === 'boolean') config.categoryHint = saved.categoryHint
    }
  } catch {
    /* 首次启动没有配置文件，用默认值 */
  }
  return config
}

/** 校验并应用一次更新，返回 { ok, error? } */
export function updateConfig(patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, error: '无效的配置' }
  const next = { ...config }
  for (const k of ['attempts', 'questions', 'categoryAt']) {
    if (patch[k] !== undefined) {
      const n = Number(patch[k])
      if (!Number.isFinite(n)) return { ok: false, error: `${k} 不是数字` }
      next[k] = clamp(n, LIMITS[k])
    }
  }
  for (const k of ['allowReveal', 'categoryHint']) {
    if (patch[k] !== undefined) next[k] = Boolean(patch[k])
  }
  Object.assign(config, next)
  persist()
  return { ok: true }
}

function persist() {
  try {
    mkdirSync(join(ROOT, 'data'), { recursive: true })
    const tmp = FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(config))
    renameSync(tmp, FILE)
  } catch (e) {
    console.error('config persist failed', e)
  }
}
