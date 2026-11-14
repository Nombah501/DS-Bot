// Inbound message policy; adapters own mentions and platform message shapes.
import { randomUUID } from 'node:crypto'
import { imPlatform } from '../../shared/im-platforms.js'
import { NUMBERS } from './card-kinds.js'

const COMMANDS = {
  bind: { capability: 'topics' },
  lang: { capability: 'personLanguage', arguments: true },
  start: {},
  stop: {},
  status: {},
}
const commandOf = (body, capabilities) => {
  const match = /^\/(\w+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(body)
  if (match === null || !Object.hasOwn(COMMANDS, match[1])) return undefined
  const command = COMMANDS[match[1]]
  if ((!command.arguments && match[2] !== undefined)
    || (command.capability !== undefined && capabilities?.[command.capability] !== true)) return undefined
  return match[1]
}

export function inbound(rt, { records, place, kinds, forumBind, connections, deliveryOf, showStatus, textForPerson, targetName, stopTarget, envFor, platformOf = imPlatform }) {
  const paired = (conn, senderId) => (conn.paired ?? []).some(entry => entry.id === senderId)
  const requested = (conn, msg) => {
    if ((conn.requests ?? []).some(entry => entry.id === msg.sender.id)) return false
    conn.requests = [...(conn.requests ?? []), { id: msg.sender.id, name: msg.sender.name, chatKey: msg.chat.key, chatKind: msg.chat.kind, chatTitle: msg.chat.title, ...(platformOf(conn.platform)?.personLanguage === true ? { languageCode: msg.sender.languageCode } : {}), at: Date.now() }]
    return true
  }
  const sendText = (conn, chat, body) => { void deliveryOf(conn.id)?.notice(chat, { text: body }) }
  const message = async (conn, msg) => {
    if (!paired(conn, msg.sender.id)) {
      const text = textForPerson(conn, msg.sender)
      if (msg.chat.kind === 'group' && !msg.mentioned) return
      if (!requested(conn, msg)) return
      await rt.save()
      await sendText(conn, msg.chat, text('requested'))
      return
    }
    if (msg.chat.kind === 'group' && !msg.mentioned && !(platformOf(conn.platform)?.topics === true && msg.chat.isForum === true)) return
    const arrival = await records.arrived(conn.id, msg)
    if (arrival.conn === undefined || arrival.chat === undefined) return
    conn = arrival.conn
    const chat = arrival.chat
    const text = textForPerson(conn, msg.sender)
    const body = String(msg.text ?? '').trim()
    const command = commandOf(body, platformOf(conn.platform))
    if (command === 'bind') {
      await forumBind.command(conn, msg)
      return
    }
    const unboundKey = chat.isForum === true ? 'bindHint' : msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'
    if (command === 'lang') {
      const person = conn.paired.find(person => person.id === msg.sender.id)
      if (person === undefined) return
      const language = body.split(/\s+/).slice(1).join(' ')
      if (['ru', 'en', 'auto'].includes(language)) {
        person.language = language
        await rt.save()
      }
      await sendText(conn, msg.chat, text('language', { language: person.language ?? 'auto' }))
      return
    }
    const target = place.targetOf(conn, msg.chat)
    if (!NUMBERS.test(body) && target !== undefined && !place.may(conn, msg.sender.id, target)) {
      await sendText(conn, msg.chat, text('denied'))
      return
    }
    if (command === 'start') {
      const name = target === undefined ? undefined : targetName(conn, target)
      await sendText(conn, msg.chat, name === undefined ? text(unboundKey) : text('greeting', { name }))
      return
    }
    if (command === 'stop') {
      if (target === undefined) {
        await sendText(conn, msg.chat, text(unboundKey))
        return
      }
      await stopTarget(conn, msg.chat, target, text)
      return
    }
    if (command === 'status') {
      if (target === undefined) {
        await sendText(conn, msg.chat, text(unboundKey))
      } else {
        await showStatus(conn, msg, target, text)
      }
      return
    }
    if (NUMBERS.test(body) && await kinds.number(conn, msg)) return
    if (target !== undefined && !place.may(conn, msg.sender.id, target)) {
      await sendText(conn, msg.chat, text('denied'))
      return
    }
    if (target === undefined) {
      await sendText(conn, msg.chat, text(unboundKey))
      return
    }
    const sessionId = target.botId ?? target.roomId
    const { botId, roomId } = target
    const content = []
    if (body !== '') content.push({ type: 'text', text: body })
    for (const image of msg.images ?? []) content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
    const env = await envFor(conn)
    for (const file of msg.files ?? []) {
      try {
        const receiptId = await env.uploadFile(rt.botOf(sessionId) ? rt.chatOf(sessionId) : sessionId, file)
        content.push({ type: 'file', receiptId })
      } catch {
        await sendText(conn, msg.chat, text('noFile'))
      }
    }
    if (content.length === 0) return
    const requestId = `im:${conn.platform}:${randomUUID()}`
    await place.asked(conn, requestId, msg.sender, msg.chat)
    // Uploads and the Origin save may adopt a new connection or change its Access/binding.
    const current = connections()[conn.id]
    const rebound = current === undefined ? undefined : place.targetOf(current, msg.chat)
    if (rebound === undefined || rebound.botId !== botId || rebound.roomId !== roomId
      || !place.may(current, msg.sender.id, rebound)) {
      await place.unasked(conn, requestId)
      const key = rebound === undefined ? unboundKey : 'denied'
      await sendText(current ?? conn, msg.chat, textForPerson(current ?? conn, msg.sender)(key))
      return
    }
    try {
      await rt.sendUser({ sessionId, content, requestId })
    } catch (error) {
      await place.unasked(conn, requestId)
      throw error
    }
  }
  return { message }
}
