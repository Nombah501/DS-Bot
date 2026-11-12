// Placement: where Bridge output for a Bot or a DS Bot group chat goes, whether an
// address can still take it, and which Bot or group an address leads to. It also
// records each turn's Origin and Initiator, because the reply-where-asked rule
// (a Bot turn answers only at its Origin) is the main input to "where".
import { imPlatform } from '../../shared/im-platforms.js'
import { allows, sameTarget } from './topics.js'

const personOf = (conn, id) => conn.paired?.find(person => person.id === id)
const topicMode = conn => imPlatform(conn?.platform)?.topics === true

export function topicTarget(conn, address) {
  const chat = conn.chats?.[address.key]
  if (chat === undefined) return undefined
  if (chat.kind === 'group' && chat.isForum === true && (address.threadId === undefined || address.threadId === 1)) {
    return chat.topics?.[1]?.target ?? (conn.botId === undefined || conn.botId === '' ? undefined : { botId: conn.botId })
  }
  if (address.threadId !== undefined) return chat.topics?.[address.threadId]?.target
  return chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
}

export function canDeliver(conn, address, target) {
  if (target === undefined || address.kind !== 'direct') return true
  if (address.threadId !== undefined && conn.chats?.[address.key]?.topics?.[address.threadId]?.closed) return false
  const chat = conn.chats?.[address.key]
  return sameTarget(topicTarget(conn, address), target)
    && allows(personOf(conn, chat?.personId), target)
}

/**
 * @param {object} deps
 * @param {() => Record<string, any>} deps.connections current connection records by id
 * @param {{ loaded: () => Iterable<[string, any]>, of: (id: string) => Promise<any>, save: (id: string) => void, saveNow: (id: string) => Promise<void> }} deps.store
 *   per-connection runtime data holding `requests` and `turns`
 * @param {(id: string) => any} deps.botOf
 * @param {(id: string) => any} deps.roomOf
 */
export function placement({ connections, store, botOf, roomOf }) {
  // A caller may hold a connection object that a save has since replaced.
  const fresh = conn => connections()[conn.id] ?? conn

  const targetIn = (conn, address) => {
    const target = topicMode(conn) && address.key !== undefined
      ? topicTarget(conn, address)
      : address.target ?? (address.kind === 'direct' ? { botId: conn.botId } : undefined)
    if (target?.botId !== undefined && botOf(target.botId) !== undefined) return target
    if (target?.roomId !== undefined && roomOf(target.roomId) !== undefined) return target
    return undefined
  }

  const bindings = (conn) => {
    const out = []
    for (const [chatKey, saved] of Object.entries(conn.chats ?? {})) {
      const chat = { ...saved, key: chatKey }
      const topics = topicMode(conn)
      const person = personOf(conn, chat.personId)
      if (topics && chat.kind === 'direct' && conn.account?.hasTopicsEnabled === true) {
        for (const [threadId, topic] of Object.entries(chat.topics ?? {})) {
          if (!topic.closed && topic.replacedBy === undefined && allows(person, topic.target)) out.push({ chatKey, chat: { ...chat, threadId: Number(threadId) }, target: topic.target })
        }
        continue
      }
      if (topics && chat.kind === 'group' && chat.isForum === true) {
        const target = topicTarget(conn, chat)
        if (target !== undefined) out.push({ chatKey, chat: { ...chat, threadId: 1 }, target })
        for (const [threadId, topic] of Object.entries(chat.topics ?? {})) {
          if (threadId !== '1') out.push({ chatKey, chat: { ...chat, threadId: Number(threadId) }, target: topic.target })
        }
        continue
      }
      const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
      if (!topics || chat.kind !== 'direct' || chat.personId === undefined || allows(person, target)) out.push({ chatKey, chat, target })
      if (topics && chat.kind === 'group') {
        for (const [threadId, topic] of Object.entries(chat.topics ?? {})) {
          if (!topic.closed && topic.replacedBy === undefined) out.push({ chatKey, chat: { ...chat, threadId: Number(threadId) }, target: topic.target })
        }
      }
    }
    return out
  }
  const listeners = (conn, owner) => bindings(conn).filter(({ target }) => {
    if (owner.botId !== undefined) return target?.botId === owner.botId && botOf(target.botId) !== undefined
    if (owner.roomId !== undefined) return target?.roomId === owner.roomId && roomOf(target.roomId) !== undefined
    return false
  })

  const initiatorAnywhere = sessionId => {
    for (const [, data] of store.loaded()) {
      const initiator = data.turns[sessionId]?.initiator
      if (initiator) return initiator
    }
    return undefined
  }

  // A Bot turn has one Telegram Origin across every connection. A revoked Origin
  // makes it an Off-Telegram turn, never a broadcast to other group bindings.
  const botPlaces = (conn, botId, sessionId, cards) => {
    const targets = listeners(conn, { botId })
    if (!topicMode(conn)) return targets
    const initiator = initiatorAnywhere(sessionId)
    const originConn = connections()[initiator?.connectionId]
    if (originConn?.enabled !== false && topicMode(originConn)) {
      const saved = originConn.chats?.[initiator.chatKey]
      const chat = { ...saved, key: initiator.chatKey, ...(initiator.threadId === undefined ? {} : { threadId: initiator.threadId }) }
      if (saved?.isForum === true && chat.threadId === undefined) chat.threadId = 1
      const topic = saved?.topics?.[chat.threadId ?? (saved?.isForum ? 1 : undefined)]
      if (saved !== undefined && !topic?.closed && topic?.replacedBy === undefined
        && targetIn(originConn, chat)?.botId === botId
        && allows(personOf(originConn, initiator.sender.id), { botId })) {
        return conn.id === originConn.id ? [{ chatKey: chat.key, chat, target: { botId } }] : []
      }
    }
    if (conn.nonTelegramTurns === 'none' || (conn.nonTelegramTurns === 'cards' && !cards)) return []
    return targets.filter(({ chat }) => chat.kind === 'direct' && allows(personOf(conn, chat.personId), { botId }))
  }

  return {
    /**
     * Addresses on this connection that output of `kind` ('message' | 'draft' |
     * 'card' | 'typing') from a Bot or a DS Bot group chat goes to. A Draft goes to
     * private chats only; only a Card passes the "only Cards" setting.
     */
    places(conn, owner, sessionId, kind) {
      const current = fresh(conn)
      const out = owner.roomId === undefined ? botPlaces(current, owner.botId, sessionId, kind === 'card') : listeners(current, owner)
      return kind === 'draft' ? out.filter(place => place.chat.kind === 'direct') : out
    },
    /** The Bot or DS Bot group chat an address leads to, if it still exists. */
    targetOf(conn, address) {
      return targetIn(conn, address)
    },
    /** Whether an address still takes output meant for `target`. */
    deliverable(conn, address, target) {
      const current = fresh(conn)
      return !topicMode(current) || canDeliver(current, address, target)
    },
    /** Moves a queued address onto the Topic that replaced its own, in place. */
    follow(conn, address) {
      const current = fresh(conn)
      if (!topicMode(current) || address.threadId === undefined) return
      while (current.chats?.[address.key]?.topics?.[address.threadId]?.replacedBy !== undefined) {
        address.threadId = current.chats[address.key].topics[address.threadId].replacedBy
      }
    },
    /** A Telegram message with this request id was sent to a Bot from `address`. */
    async asked(conn, requestId, sender, address) {
      const data = await store.of(conn.id)
      if (imPlatform(conn.platform)?.privateCards !== true) return
      data.requests[requestId] = { sender, connectionId: conn.id, chatKey: address.key, ...(address.threadId === undefined ? {} : { threadId: address.threadId }) }
      await store.saveNow(conn.id)
    },
    /** The request was never delivered to the Bot. */
    async unasked(conn, requestId) {
      const data = await store.of(conn.id)
      delete data.requests[requestId]
      store.save(conn.id)
    },
    /** Turns a session's turn events into its Origin and Initiator record. */
    sessionEvent(session, event) {
      const rpcId = event.type === 'user/message' ? event.data?.source?.rpcId : undefined
      const conns = connections()
      let request
      if (rpcId !== undefined) {
        for (const [id, data] of store.loaded()) {
          if (conns[id] !== undefined && data.requests[rpcId]) {
            request = data.requests[rpcId]
            break
          }
        }
      }
      for (const [id, data] of store.loaded()) {
        if (imPlatform(conns[id]?.platform)?.privateCards !== true
          || !['turn/start', 'user/message', 'turn/end'].includes(event.type)) continue
        if (event.type === 'turn/start') data.turns[session.id] = { turn: event.data.turn }
        if (event.type === 'user/message') {
          const turn = data.turns[session.id]
          if (turn !== undefined && turn.opened !== true) {
            turn.opened = true
            if (request !== undefined) turn.initiator = request
          }
          if (request !== undefined) delete data.requests[rpcId]
        }
        if (event.type === 'turn/end') delete data.turns[session.id]
        store.save(id)
      }
    },
    /** The Initiator of a session's running turn, as this connection recorded it. */
    async initiatorOf(conn, sessionId) {
      return (await store.of(conn.id)).turns[sessionId]?.initiator
    },
  }
}
