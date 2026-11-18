// Upstream reply provenance for platforms without Topics. Telegram keeps its
// persisted Origin and Initiator in Placement instead of the mixed-source rule.
import { randomUUID } from 'node:crypto'
import { REPLY_KIND, SOURCE_KIND } from '../constants.js'
import { sameTarget } from './topics.js'

export function replyOrigins({ connections, targetOf, roomOf, roomActive }) {
  const origins = new Map()
  const mixed = new Set()
  const pendingReset = new Set()
  const requests = new Map()
  const held = new Map()
  const reset = sessionId => { origins.delete(sessionId); mixed.delete(sessionId) }
  const drop = sessionId => {
    origins.delete(sessionId)
    mixed.add(sessionId)
    for (const [token, entry] of held) if (entry.activeOn === sessionId) held.delete(token)
  }
  const claim = (sessionId, entry) => {
    if (sessionId === undefined || mixed.has(sessionId)) return
    const previous = origins.get(sessionId)
    if (previous !== undefined && (previous.connectionId !== entry.connectionId || previous.chatKey !== entry.chatKey || previous.sender.id !== entry.sender.id)) {
      drop(sessionId)
      return
    }
    for (const [token, retained] of held) {
      if (retained.activeOn === sessionId && (retained.connectionId !== entry.connectionId || retained.chatKey !== entry.chatKey || retained.sender.id !== entry.sender.id)) held.delete(token)
    }
    origins.set(sessionId, entry)
  }
  const capture = (conn, sender, address) => {
    const target = targetOf(conn, address)
    return {
      connectionId: conn.id, chatKey: address.key, sender,
      target: target === undefined ? undefined : { ...target },
    }
  }
  const valid = entry => {
    const conn = connections()[entry?.connectionId]
    const chat = conn?.chats?.[entry?.chatKey]
    return conn !== undefined && conn.enabled !== false && chat !== undefined
      && conn.paired?.some(person => person.id === entry.sender.id)
      && entry.target !== undefined && sameTarget(targetOf(conn, { ...chat, key: entry.chatKey }), entry.target)
  }
  return {
    of: sessionId => origins.get(sessionId),
    valid,
    capture,
    claim,
    asked: (conn, requestId, sender, address) => requests.set(requestId, capture(conn, sender, address)),
    unasked: requestId => requests.delete(requestId),
    hold(sessionId) {
      const entry = origins.get(sessionId)
      if (entry === undefined || mixed.has(sessionId)) return
      const token = randomUUID()
      held.set(token, { ...entry, activeOn: sessionId })
      return token
    },
    peek(sessionId, token) {
      const entry = held.get(token)
      if (entry === undefined) return
      claim(sessionId, entry)
      if (!mixed.has(sessionId)) entry.activeOn = sessionId
    },
    release: token => held.delete(token),
    clear() { origins.clear(); mixed.clear(); pendingReset.clear(); requests.clear(); held.clear() },
    sessionEvent(session, event) {
      if (event.type === 'turn/start') {
        const room = roomOf(session.id)
        if (room === undefined) reset(session.id)
        else if (!roomActive(room.id)) pendingReset.add(session.id)
      }
      if (event.type === 'user/message') {
        const source = event.data?.source
        const token = source?.imOrigin
        const rpcId = source?.rpcId
        if (pendingReset.delete(session.id) && !(typeof token === 'string' || (source?.kind === SOURCE_KIND && source.role === 'post'))) reset(session.id)
        if (typeof token === 'string') {
          const entry = held.get(token)
          held.delete(token)
          if (entry === undefined) drop(session.id)
          else claim(session.id, entry)
        } else if (typeof rpcId === 'string' && rpcId.startsWith('im:')) {
          const entry = requests.get(rpcId)
          requests.delete(rpcId)
          if (entry === undefined) drop(session.id)
          else claim(session.id, entry)
        } else if (source?.kind === REPLY_KIND || !(source?.kind === SOURCE_KIND && source.role === 'post')) {
          drop(session.id)
        }
      }
      if (event.type === 'turn/end') {
        if (roomOf(session.id) === undefined) {
          reset(session.id)
          for (const entry of held.values()) if (entry.activeOn === session.id) entry.activeOn = undefined
        } else if (pendingReset.delete(session.id)) reset(session.id)
      }
    },
  }
}
