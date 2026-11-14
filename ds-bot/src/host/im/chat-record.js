// Saved chat fields live here; Topic bindings and bind Cards have their own writers.
import { imPlatform } from '../../shared/im-platforms.js'

export function setPersonId(chat, person) {
  if (chat.kind !== 'direct' || person === undefined || chat.personId === person.id) return false
  chat.personId = person.id
  return true
}

export function chatRecords(rt, { connections, platformOf = imPlatform }) {
  const resolve = (connId, chatKey) => {
    const conn = connections()[connId]
    return { conn, chat: conn?.chats?.[chatKey] }
  }
  const update = async (connId, chatKey, change) => {
    const changed = change(resolve(connId, chatKey))
    if (changed) await rt.save()
    // A save can adopt a different object graph. Never return its detached records.
    return resolve(connId, chatKey)
  }
  const create = (conn, chatKey, kind, title) => {
    conn.chats ??= {}
    if (conn.chats[chatKey] !== undefined) return false
    conn.chats[chatKey] = { kind, title, at: Date.now() }
    return true
  }
  const hear = (conn, chat, sender) => {
    if (platformOf(conn.platform)?.personLanguage !== true || chat === undefined
      || (chat.languageCode === sender.languageCode && chat.lastSenderId === sender.id)) return false
    chat.languageCode = sender.languageCode
    chat.lastSenderId = sender.id
    return true
  }
  const arrived = (connId, msg) => update(connId, msg.chat.key, ({ conn }) => {
    let changed = create(conn, msg.chat.key, msg.chat.kind, msg.chat.title)
    const chat = conn.chats[msg.chat.key]
    if (platformOf(conn.platform)?.topics === true && msg.chat.isForum === true && chat.isForum !== true) {
      chat.isForum = true
      changed = true
    }
    changed = setPersonId(chat, conn.paired?.find(person => person.id === msg.sender.id)) || changed
    return hear(conn, chat, msg.sender) || changed
  })
  const heard = (connId, chatKey, sender) => update(connId, chatKey, ({ conn, chat }) => hear(conn, chat, sender))
  const paired = (connId, request) => update(connId, request.chatKey, ({ conn }) => {
    create(conn, request.chatKey, request.chatKind, request.chatTitle ?? request.name)
    const chat = conn.chats[request.chatKey]
    setPersonId(chat, conn.paired?.find(person => person.id === request.id))
    if (platformOf(conn.platform)?.personLanguage === true) chat.languageCode = request.languageCode
    // Acceptance also changed the connection's pairing state before this call.
    return true
  })
  const setTarget = (connId, chatKey, target) => update(connId, chatKey, ({ chat }) => {
    if (chat.target?.botId === target?.botId && chat.target?.roomId === target?.roomId) return false
    if (target === undefined) delete chat.target
    else chat.target = target
    return true
  })
  const remove = (connId, chatKey) => update(connId, chatKey, ({ conn, chat }) => {
    if (chat === undefined) return false
    delete conn.chats[chatKey]
    return true
  })
  return { arrived, heard, paired, setTarget, remove }
}
