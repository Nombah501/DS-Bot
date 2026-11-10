// Telegram keeps physical chats separate from Topic bindings. botId is the
// connection's Default Bot, not a restriction on the team's reachable targets.
export const addressKey = chat => chat.threadId === undefined ? chat.key : JSON.stringify([chat.key, chat.threadId])
export const sameTarget = (left, right) => left !== undefined && right !== undefined && left.botId === right.botId && left.roomId === right.roomId
export const allows = (person, target) => person !== undefined && target !== undefined && (person.access === 'all' || person.access === undefined
  || (target.botId !== undefined ? person.access.botIds?.includes(target.botId) : person.access.roomIds?.includes(target.roomId)))

export function migrateTopics(conn) {
  let changed = false
  for (const person of conn.paired ?? []) {
    if (person.access !== undefined) continue
    person.access = 'all'
    changed = true
  }
  // Before Topics, a direct chat recorded no owner. Telegram private chat IDs
  // equal the other participant's user ID; pairing now stores this explicitly.
  for (const [key, chat] of Object.entries(conn.chats ?? {})) {
    if (chat.kind === 'direct' && chat.personId === undefined && conn.paired?.some(person => person.id === key)) {
      chat.personId = key
      changed = true
    }
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

export function topicTarget(conn, address) {
  const chat = conn.chats?.[address.key]
  if (chat === undefined) return undefined
  if (address.threadId !== undefined) return chat.topics?.[address.threadId]?.target
  return chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
}

export function canDeliver(conn, address, target) {
  if (target === undefined || address.kind !== 'direct') return true
  const chat = conn.chats?.[address.key]
  return sameTarget(topicTarget(conn, address), target)
    && allows(conn.paired?.find(person => person.id === chat?.personId), target)
}

export function privateTopicCreator(rt, handleOf) {
  const pending = new Map()
  return function ensurePrivateTopics(conn, chatKey) {
    const key = JSON.stringify([conn.id, chatKey])
    if (pending.has(key)) return pending.get(key)
    const run = (async () => {
      const chat = conn.chats?.[chatKey]
      const handle = handleOf(conn.id)
      if (conn.account?.hasTopicsEnabled !== true || chat?.kind !== 'direct' || typeof handle?.createTopic !== 'function') return
      const person = conn.paired?.find(person => person.id === chat.personId)
      if (person === undefined) return
      for (const target of accessTargets(person, rt.state)) {
        if (Object.values(chat.topics ?? {}).some(topic => sameTarget(topic.target, target))) continue
        const name = (target.botId !== undefined ? rt.botOf(target.botId) : rt.roomOf(target.roomId))?.name
        const topic = await handle.createTopic({ key: chatKey, kind: chat.kind }, name)
        // Pairing/access can change while the network is in flight.
        if (!allows(conn.paired?.find(entry => entry.id === person.id), target)) continue
        chat.topics ??= {}
        chat.topics[topic.threadId] = { target, name, at: Date.now() }
        await rt.save()
      }
    })().finally(() => pending.delete(key))
    pending.set(key, run)
    return run
  }
}
