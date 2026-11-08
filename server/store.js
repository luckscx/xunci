import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'data')
const FILE = join(DIR, 'state.json')
const TMP = FILE + '.tmp'

let dirty = false

/** 启动时读取上次落盘的对局状态；首次启动或文件损坏都当作没有 */
export function loadState() {
  try {
    const s = JSON.parse(readFileSync(FILE, 'utf8'))
    if (s && Array.isArray(s.games)) return s
  } catch {
    /* ignore */
  }
  return null
}

/** 任何内存状态变更后调用一次，标记待落盘 */
export function touch() {
  dirty = true
}

/** 原子写：先写临时文件再改名，进程任意时刻被杀都不会留下半个 JSON */
export function flush(state) {
  if (!dirty) return
  mkdirSync(DIR, { recursive: true })
  writeFileSync(TMP, JSON.stringify(state))
  renameSync(TMP, FILE)
  dirty = false
}

/** 每 2s 检查落盘一次，退出时兜底刷一次 */
export function startPersist(getState) {
  setInterval(() => flush(getState()), 2000).unref()
  process.on('exit', () => flush(getState()))
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}
