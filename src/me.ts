import type { Identity } from './api'
import { randomName } from './name'

const KEY = 'xunci.me.v1'

/** randomUUID 只在安全上下文（HTTPS / localhost）可用，用 IP 或内网域名访问时要兜底 */
function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    c.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function loadMe(): Identity {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '') as Identity
    if (raw?.id && raw?.name) return raw
  } catch {
    /* ignore */
  }
  const me: Identity = { id: newId(), name: randomName() }
  saveMe(me)
  return me
}

export function saveMe(me: Identity) {
  try {
    localStorage.setItem(KEY, JSON.stringify(me))
  } catch {
    /* ignore */
  }
}
