// Telegram keeps physical chats separate from Topic bindings. botId is the
// connection's Default Bot, not a restriction on the team's reachable targets.
import { imPlatform } from '../../shared/im-platforms.js'
import { setPersonId } from './chat-record.js'

export const addressKey = chat => chat.threadId === undefined ? chat.key : JSON.stringify([chat.key, chat.threadId])
export const sameTarget = (left, right) => left !== undefined && right !== undefined && left.botId === right.botId && left.roomId === right.roomId
// A Topic that still carries output: not closed and not replaced by a new thread.
export const topicLive = topic => !topic?.closed && topic?.replacedBy === undefined
export const allows = (person, target) => person !== undefined && target !== undefined && (person.access === 'all' || person.access === undefined
  || (target.botId !== undefined ? person.access.botIds?.includes(target.botId) : person.access.roomIds?.includes(target.roomId)))

export function migrateTopics(conn) {
  let changed = false
  if (conn.nonTelegramTurns === undefined) {
    conn.nonTelegramTurns = 'all'
    changed = true
  }
  for (const person of conn.paired ?? []) {
    if (person.access !== undefined) continue
    person.access = 'all'
    changed = true
  }
  // Before Topics, a direct chat recorded no owner. Telegram private chat IDs
  // equal the other participant's user ID; pairing now stores this explicitly.
  for (const [key, chat] of Object.entries(conn.chats ?? {})) {
    if (chat.personId === undefined) changed = setPersonId(chat, conn.paired?.find(person => person.id === key)) || changed
  }
  return changed
}

export function cleanAccess(value, rt) {
  if (value === undefined || value === 'all') return 'all'
  const invalid = () => { throw new Error('Choose all Bots and groups or an Access list of existing Bots and groups') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'botIds' && key !== 'roomIds')
    || !Array.isArray(value.botIds) || !Array.isArray(value.roomIds)) return invalid()
  if (value.botIds.some(id => typeof id !== 'string' || rt.botOf(id) === undefined)
    || value.roomIds.some(id => typeof id !== 'string' || rt.roomOf(id) === undefined)) return invalid()
  return { botIds: [...new Set(value.botIds)], roomIds: [...new Set(value.roomIds)] }
}

export function accessTargets(person, state) {
  return [
    ...Object.keys(state.bots).map(botId => ({ botId })),
    ...Object.keys(state.rooms).map(roomId => ({ roomId })),
  ].filter(target => allows(person, target))
}

export function topics(rt, { connections, handleOf, textForChat, deliverable, replaced = [], platformOf = imPlatform }) {
  const ensuring = new Map()
  const replacing = new Map()
  const chatOf = (connId, chatKey) => connections()[connId]?.chats?.[chatKey]
  const nameOf = target => (target.botId !== undefined ? rt.botOf(target.botId) : rt.roomOf(target.roomId))?.name
  const privateChat = (connId, chatKey) => platformOf(connections()[connId]?.platform)?.topics === true && chatOf(connId, chatKey)?.kind === 'direct'
  // Plans contain values, never records from the state graph that an await can detach.
  const plan = (connId, chatKey, threadId) => {
    const conn = connections()[connId]
    const chat = conn?.chats?.[chatKey]
    const topic = chat?.topics?.[threadId]
    if (topic === undefined) return undefined
    const name = nameOf(topic.target)
    return {
      target: { ...topic.target }, name, previousName: topic.name,
      closed: topic.closed, notified: topic.notified, replacedBy: topic.replacedBy,
      reason: name === undefined ? 'topicDeleted' : !allows(conn.paired?.find(person => person.id === chat.personId), topic.target) ? 'topicRevoked' : undefined,
    }
  }
  const update = async (connId, chatKey, change) => {
    if (!change(chatOf(connId, chatKey))) return false
    await rt.save()
    return true
  }
  const changeTopic = (connId, chatKey, threadId, change) => update(connId, chatKey, chat => {
    const topic = chat?.topics?.[threadId]
    if (topic === undefined) return false
    change(topic)
    return true
  })
  const record = (connId, chatKey, threadId, target, name, oldThreadId) => update(connId, chatKey, chat => {
    if (chat === undefined) return false
    chat.topics ??= {}
    chat.topics[threadId] = { target, name, at: Date.now() }
    if (oldThreadId !== undefined && chat.topics[oldThreadId] !== undefined) chat.topics[oldThreadId].replacedBy = threadId
    return true
  })
  const replace = (connId, chatKey, threadId) => {
    const key = JSON.stringify([connId, chatKey, threadId])
    if (replacing.has(key)) return replacing.get(key)
    const run = (async () => {
      const next = plan(connId, chatKey, threadId)
      if (next === undefined) return undefined
      if (next.replacedBy !== undefined) return next.replacedBy
      const created = await handleOf(connId).createTopic({ key: chatKey, kind: 'direct' }, next.name)
      if (!await record(connId, chatKey, created.threadId, next.target, next.name, threadId)) return undefined
      for (const subscriber of replaced) await subscriber(connId, chatKey, threadId, created.threadId)
      return created.threadId
    })().finally(() => replacing.delete(key))
    replacing.set(key, run)
    return run
  }
  const reconcile = async (connId, chatKey, threadId) => {
    const next = plan(connId, chatKey, threadId)
    if (next === undefined || next.replacedBy !== undefined) return
    const address = { key: chatKey, kind: 'direct', threadId }
    if (next.closed) {
      if (next.reason !== undefined) return
      try {
        await handleOf(connId).reopenTopic(address)
      } catch (error) {
        if (error?.topicMissing !== true) throw error
        await replace(connId, chatKey, threadId)
        return
      }
      await changeTopic(connId, chatKey, threadId, topic => { delete topic.closed; delete topic.notified })
    } else if (next.reason !== undefined) {
      if (!next.notified) {
        await handleOf(connId).send(address, { text: textForChat(connections()[connId], chatKey)(next.reason, { name: next.previousName }) })
        await changeTopic(connId, chatKey, threadId, topic => { topic.notified = true })
      }
      if (plan(connId, chatKey, threadId) === undefined) return
      await handleOf(connId).closeTopic(address)
      await changeTopic(connId, chatKey, threadId, topic => { topic.closed = true })
      return
    }
    const current = plan(connId, chatKey, threadId)
    if (current !== undefined && current.name !== undefined && current.previousName !== current.name) {
      await handleOf(connId).renameTopic(address, current.name)
      await changeTopic(connId, chatKey, threadId, topic => { topic.name = current.name })
    }
  }
  const targets = (connId, chatKey) => {
    const conn = connections()[connId]
    const chat = conn?.chats?.[chatKey]
    const person = conn?.paired?.find(person => person.id === chat?.personId)
    return conn?.account?.hasTopicsEnabled === true && person !== undefined ? accessTargets(person, rt.state) : []
  }
  const needsTopic = (connId, chatKey, target) => targets(connId, chatKey).some(current => sameTarget(current, target))
    && !Object.values(chatOf(connId, chatKey)?.topics ?? {}).some(topic => topicLive(topic) && sameTarget(topic.target, target))
  return {
    ensure(conn, chatKey) {
      const connId = conn.id
      const key = JSON.stringify([connId, chatKey])
      if (ensuring.has(key)) return ensuring.get(key)
      const run = (async () => {
        if (!privateChat(connId, chatKey) || handleOf(connId) === undefined) return
        for (const threadId of Object.keys(chatOf(connId, chatKey).topics ?? {})) await reconcile(connId, chatKey, Number(threadId))
        for (const target of targets(connId, chatKey)) {
          if (!privateChat(connId, chatKey) || !needsTopic(connId, chatKey, target)) continue
          const name = nameOf(target)
          const created = await handleOf(connId).createTopic({ key: chatKey, kind: 'direct' }, name)
          // Access can be revoked in flight; record the Topic so the next sweep can close it.
          await record(connId, chatKey, created.threadId, target, name)
        }
      })().finally(() => ensuring.delete(key))
      ensuring.set(key, run)
      return run
    },
    async restore(conn, address) {
      const connId = conn.id
      const next = plan(connId, address.key, address.threadId)
      if (!privateChat(connId, address.key) || next === undefined || next.closed || handleOf(connId) === undefined) return undefined
      if (next.replacedBy !== undefined) return next.replacedBy
      if (next.name === undefined || !deliverable(connections()[connId], address, next.target)) return undefined
      return replace(connId, address.key, address.threadId)
    },
    bind(connId, chatKey, threadId, target) {
      return record(connId, chatKey, threadId, target, nameOf(target))
    },
  }
}
