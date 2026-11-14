import { randomUUID } from 'node:crypto'
import { imPlatform } from '../../shared/im-platforms.js'
import { accessTargets } from './topics.js'
import { settledCard } from './cards.js'

// Bind Cards belong to their requesting person and physical Topic, not the
// Topic's current target: an unbound/inaccessible Topic must still be bindable.
export function forumBinder(rt, { connections, topics, handleOf, deliveryOf, sendText, sendCardReply, textForPerson, may }) {
  const nameOf = target => (target.botId === undefined ? rt.roomOf(target.roomId) : rt.botOf(target.botId))?.name
  const cardOf = (connId, chatKey, key) => connections()[connId]?.chats?.[chatKey]?.bindCards?.[key]
  const changeCard = (connId, chatKey, key, id, change) => {
    const held = cardOf(connId, chatKey, key)
    if (held?.id !== id) return false
    change(held)
    return true
  }
  const admin = async (conn, chat, sender, action) => {
    const handle = handleOf(conn.id)
    try {
      if (imPlatform(conn.platform)?.forumAdmin === true && handle !== undefined && await handle.isAdmin(chat, sender.id)) return true
    } catch (error) {
      rt.warn('ds-bot: forum admin check failed: %s', rt.redactSecrets(String(error?.message ?? error)))
    }
    await sendCardReply(conn, chat, textForPerson(conn, sender)('bindAdmin'), action)
    return false
  }
  return {
    async command(conn, msg) {
      const connId = conn.id
      const text = textForPerson(conn, msg.sender)
      if (connections()[connId]?.chats?.[msg.chat.key]?.isForum !== true || msg.chat.kind !== 'group') {
        sendText(conn, msg.chat, text('bindForum'))
        return
      }
      if (!await admin(conn, msg.chat, msg.sender)) return
      conn = connections()[connId]
      if (conn?.chats?.[msg.chat.key]?.isForum !== true) return
      const person = conn.paired?.find(person => person.id === msg.sender.id)
      const targets = accessTargets(person, rt.state)
      if (targets.length === 0) {
        sendText(conn, msg.chat, text('bindEmpty'))
        return
      }
      const id = randomUUID()
      const card = { text: text('bindChoose'), options: targets.map((target, index) => ({ label: nameOf(target), data: `b:${id}:${index}` })) }
      const key = msg.chat.threadId ?? 1
      const hold = () => {
        const saved = connections()[connId]?.chats?.[msg.chat.key]
        if (saved === undefined) return
        saved.bindCards ??= {}
        saved.bindCards[key] = { id, senderId: msg.sender.id, targets, card }
      }
      hold()
      await rt.save()
      if (cardOf(connId, msg.chat.key, key)?.id !== id) return
      void deliveryOf(connId)?.notice(msg.chat, { card }, { sent: async sent => {
        if (!changeCard(connId, msg.chat.key, key, id, held => {
          held.messageId = sent?.messageId
          held.cardFormat = sent?.cardFormat
        })) return
        await rt.save()
      } })
    },
    async action(conn, action) {
      const text = textForPerson(conn, action.sender)
      const connId = conn.id
      const key = action.chat.threadId ?? 1
      const match = /^b:([^:]+):(\d+)$/.exec(action.data)
      const id = match?.[1]
      const choice = () => {
        const held = cardOf(connId, action.chat.key, key)
        const target = held?.id === id && match ? held.targets[Number(match[2])] : undefined
        return !held?.settled && held?.senderId === action.sender.id && target !== undefined ? { ...target } : undefined
      }
      const target = choice()
      if (connections()[connId]?.chats?.[action.chat.key]?.isForum !== true || target === undefined || nameOf(target) === undefined) {
        await sendCardReply(conn, action.chat, text('stale'), action)
        return
      }
      if (!may(conn, action.sender.id, target)) {
        await sendCardReply(conn, action.chat, text('denied'), action)
        return
      }
      if (!await admin(conn, action.chat, action.sender, action)) return
      // Recheck after the network boundary; access or the Card may have changed.
      conn = connections()[connId]
      if (conn?.chats?.[action.chat.key]?.isForum !== true || choice() === undefined || !may(conn, action.sender.id, target) || nameOf(target) === undefined) return
      changeCard(connId, action.chat.key, key, id, held => { held.settled = true })
      await topics.bind(connId, action.chat.key, key, target)
      const label = nameOf(target)
      // The pressed choice settles under the target's current name.
      if (!changeCard(connId, action.chat.key, key, id, held => {
        held.card.settled = settledCard({ options: [{ label }] }, text('bindBound', { target: label }), [label])
      })) return
      await rt.save()
      const current = structuredClone(cardOf(connId, action.chat.key, key))
      const handle = handleOf(connId)
      if (current?.id === id && current.messageId !== undefined && imPlatform(connections()[connId]?.platform)?.richCards === true && handle !== undefined) {
        await handle.editCard(action.chat, current.messageId, current.card, current.cardFormat)
      }
    },
  }
}
