import { randomUUID } from 'node:crypto'
import { accessTargets, addressKey } from './topics.js'
import { settledCard } from './cards.js'

// Bind Cards belong to their requesting person and physical Topic, not the
// Topic's current target: an unbound/inaccessible Topic must still be bindable.
export function forumBinder(rt, { handleOf, enqueue, sendText, sendCardReply, textFor, may }) {
  const nameOf = target => (target.botId === undefined ? rt.roomOf(target.roomId) : rt.botOf(target.botId))?.name
  const admin = async (conn, chat, sender, action) => {
    const handle = handleOf(conn.id)
    try {
      if (typeof handle?.isAdmin === 'function' && await handle.isAdmin(chat, sender.id)) return true
    } catch (error) {
      rt.warn('ds-bot: forum admin check failed: %s', rt.redactSecrets(String(error?.message ?? error)))
    }
    await sendCardReply(conn, chat, textFor(conn, sender)('bindAdmin'), action)
    return false
  }
  return {
    async command(conn, msg) {
      const saved = conn.chats[msg.chat.key]
      const text = textFor(conn, msg.sender)
      if (saved?.isForum !== true || msg.chat.kind !== 'group') {
        sendText(conn, msg.chat, text('bindForum'))
        return
      }
      if (!await admin(conn, msg.chat, msg.sender)) return
      const person = conn.paired?.find(person => person.id === msg.sender.id)
      const targets = accessTargets(person, rt.state)
      if (targets.length === 0) {
        sendText(conn, msg.chat, text('bindEmpty'))
        return
      }
      const id = randomUUID()
      const card = { text: text('bindChoose'), options: targets.map((target, index) => ({ label: nameOf(target), data: `b:${id}:${index}` })) }
      const held = { id, senderId: msg.sender.id, targets, card }
      const key = msg.chat.threadId ?? 1
      saved.bindCards ??= {}
      saved.bindCards[key] = held
      await rt.save()
      enqueue(conn, addressKey(msg.chat), { chat: msg.chat, card, after: async sent => {
        held.messageId = sent?.messageId
        held.cardFormat = sent?.cardFormat
        await rt.save()
      } })
    },
    async action(conn, action) {
      const text = textFor(conn, action.sender)
      const saved = conn.chats?.[action.chat.key]
      const key = action.chat.threadId ?? 1
      const held = saved?.bindCards?.[key]
      const match = /^b:([^:]+):(\d+)$/.exec(action.data)
      const target = match && held?.id === match[1] ? held.targets[Number(match[2])] : undefined
      if (saved?.isForum !== true || held?.settled || held?.senderId !== action.sender.id || target === undefined || nameOf(target) === undefined) {
        await sendCardReply(conn, action.chat, text('stale'), action)
        return
      }
      if (!may(conn, action.sender.id, target)) {
        await sendCardReply(conn, action.chat, text('denied'), action)
        return
      }
      if (!await admin(conn, action.chat, action.sender, action)) return
      // Recheck after the network boundary; access or the Card may have changed.
      if (saved.bindCards[key] !== held || held.settled || !may(conn, action.sender.id, target) || nameOf(target) === undefined) return
      held.settled = true
      saved.topics ??= {}
      saved.topics[key] = { target, name: nameOf(target), at: Date.now() }
      await rt.save()
      const label = nameOf(target)
      held.card.settled = settledCard(held.card, text('bindBound', { target: label }), [held.card.options[Number(match[2])].label])
      await rt.save()
      if (held.messageId !== undefined) await handleOf(conn.id)?.editCard?.(action.chat, held.messageId, held.card, held.cardFormat)
    },
  }
}
