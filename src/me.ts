import type { Identity } from './api'
import { randomName } from './name'

const KEY = 'xunci.me.v1'

export function loadMe(): Identity {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '') as Identity
    if (raw?.id && raw?.name) return raw
  } catch {
    /* ignore */
  }
  const me: Identity = { id: crypto.randomUUID(), name: randomName() }
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
