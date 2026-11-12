// A real Placement over plain connection records and an in-memory runtime store.
import { placement } from '../src/host/im/placement.js'

// One Telegram connection: Ann (9) has a private chat (5) with Topic 101 for Bot a,
// and a forum (-60) whose thread 40 is bound to Bot a.
export const telegram = (id = 'c1', extra = {}) => ({
  id, platform: 'telegram', enabled: true, botId: 'a', nonTelegramTurns: 'all',
  account: { hasTopicsEnabled: true },
  paired: [{ id: '9', name: 'Ann', access: 'all' }],
  chats: {
    5: { kind: 'direct', personId: '9', topics: { 101: { target: { botId: 'a' }, name: 'Chief' } } },
    '-60': { kind: 'group', isForum: true, topics: { 40: { target: { botId: 'a' } } } },
  },
  ...extra,
})

export const setup = (conns) => {
  const byId = Object.fromEntries(conns.map(conn => [conn.id, conn]))
  // Every started connection has its runtime loaded, as start() does in production.
  const files = new Map(conns.map(conn => [conn.id, { requests: {}, turns: {} }]))
  const store = {
    loaded: () => files.entries(),
    of: async id => {
      if (!files.has(id)) files.set(id, { requests: {}, turns: {} })
      return files.get(id)
    },
    save: () => {},
    saveNow: async () => {},
  }
  const team = { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Scout' } }
  const place = placement({ connections: () => byId, store, botOf: id => team[id], roomOf: id => id === 'r' ? { id: 'r' } : undefined })
  return { place, store, byId }
}
