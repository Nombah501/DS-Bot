// Stop and Status snapshot policy, with connection parts supplied by the caller.
import { randomUUID } from 'node:crypto'
import { imPlatform } from '../../shared/im-platforms.js'
import { statusData } from './status-panel.js'

export async function showStatus(rt, { chat, target, text, steps, richCards, sendCard, sendText }) {
  const data = statusData(rt, target, text, steps)
  const body = `${data.name} — ${data.state}\n${text('statusTool')}: ${data.tool || '—'}\n${text('statusStep')}: ${data.step}\n${text('statusElapsed')}: ${data.since === null ? 0 : Math.max(0, Math.floor((Date.now() - data.since) / 1000))} s`
  if (data.active && richCards && sendCard !== undefined) {
    const key = `t:${randomUUID()}`
    await sendCard(key, [{ chat, target }], body, undefined,
      () => ({ text: body, options: [{ data: `${key}:stop`, label: text('stop') }] }))
  } else {
    sendText(body)
  }
}

export function stops(rt, { cards, place, runnerOf, sendText, textForPerson, textForChat, sourceOpen, platformOf = imPlatform }) {
  const steps = new Map()
  const paired = (conn, senderId) => (conn.paired ?? []).some(entry => entry.id === senderId)
  const reply = async (conn, chat, body, action) => {
    // Message replies have no action; even on callback-capable platforms this is optional.
    if (platformOf(conn.platform)?.callbackAnswer === true && typeof action?.answer === 'function') return action.answer(body)
    return sendText(conn, chat, body)
  }
  const stopTarget = async (conn, chat, target, text, action) => {
    runnerOf(conn.id)?.drafts?.endTarget(target)
    const stopped = target.botId !== undefined ? await rt.stopChat(target.botId) : await rt.stopRoomWork(target.roomId)
    await reply(conn, chat, text(stopped ? 'stopped' : 'idle'), action)
    return stopped
  }
  const draft = async (conn, { chat, draftId }) => {
    const runner = runnerOf(conn.id)
    if (platformOf(conn.platform)?.drafts !== true || chat.kind !== 'direct' || !Number.isSafeInteger(draftId) || draftId === 0) return
    const copy = runner?.drafts?.find(chat, draftId)
    if (copy === undefined) return
    const current = conn.chats?.[chat.key]
    const target = current === undefined ? undefined : place.targetOf(conn, chat)
    if (!place.may(conn, current?.personId, target)) return
    if (target === undefined || target.botId !== copy.target.botId || target.roomId !== copy.target.roomId) return
    await stopTarget(conn, copy.chat, target, textForChat(conn, chat.key))
  }
  const widgetQuery = async (conn, action) => {
    if (platformOf(conn.platform)?.statusPanel !== true || action.chat.kind !== 'direct'
      || action.type !== 'data' || action.data !== 'stop' || !paired(conn, action.sender.id)) return
    const record = runnerOf(conn.id)?.panels?.find(action.chat.key, action.messageId)
    if (record === undefined || !place.may(conn, action.sender.id, record.target)) return
    // A widget press may not carry the sender's language; the chat's last one stands in.
    const sender = { id: action.sender.id, languageCode: action.sender.languageCode ?? conn.chats?.[action.chat.key]?.languageCode }
    await stopTarget(conn, record.chat, record.target, textForPerson(conn, sender))
  }
  const handles = (conn, action) => platformOf(conn.platform)?.statusPanel === true && String(action.data ?? '').startsWith('t:')
  const unpaired = (conn, action) => reply(conn, action.chat, textForPerson(conn, action.sender)('denied'), action)
  // Routing checks pairing before records.heard yields, as it does for other Card kinds.
  const press = async (conn, action) => {
    const text = textForPerson(conn, action.sender)
    const { chat } = action
    // Button data is `<kind>:<id>:<choice>`; the id is everything between the
    // first and the last colon, so an id with a colon in it still parses.
    const data = String(action.data ?? '')
    const cut = data.lastIndexOf(':')
    const cardKey = data.slice(0, cut)
    const choice = data.slice(cut + 1)
    const entry = cards.byMessage(conn, chat, cardKey, action.messageId)
    if ((chat.kind !== 'group' && chat.kind !== 'direct') || choice !== 'stop' || entry === undefined) {
      await reply(conn, chat, text('idle'), action)
      return
    }
    if (!place.may(conn, action.sender.id, entry.target) || !place.deliverable(conn, chat, { target: entry.target })) {
      await reply(conn, chat, text('denied'), action)
      return
    }
    if (entry.answer !== undefined || !statusData(rt, entry.target, text, steps).active) {
      await cards.settle(conn, cardKey, text => text('idle'), [])
      await reply(conn, chat, text('idle'), action)
      return
    }
    // Claim this snapshot before cancellation yields, so a second press cannot stop twice.
    await cards.claim(conn, cardKey, text => text('stopped'), [])
    await stopTarget(conn, chat, entry.target, text, action)
    await cards.edits(conn)
  }
  const show = async (conn, msg, target, text) => {
    const runner = runnerOf(conn.id)
    await showStatus(rt, {
      chat: msg.chat, target, text, steps,
      richCards: platformOf(conn.platform)?.richCards === true,
      sendCard: runner?.handle !== undefined && platformOf(conn.platform)?.richCards === true ? (...args) => cards.send(conn, ...args) : undefined,
      sendText: body => runner?.delivery.output({ chat: msg.chat, target }, { text: body, rich: true }),
    })
  }
  const open = conn => {
    const otherOpen = sourceOpen()
    return (cardKey, entries) => cardKey.startsWith('t:') && platformOf(conn.platform)?.statusPanel === true
      ? entries.some(entry => place.deliverable(conn, { key: entry.chatKey, kind: conn.chats?.[entry.chatKey]?.kind, threadId: entry.threadId }, { target: entry.target })
        && statusData(rt, entry.target, textForChat(conn, entry.chatKey), steps).active)
      : otherOpen(cardKey)
  }
  const sessionEvent = (session, event) => {
    if (event.type === 'step/start' && Number.isSafeInteger(event.data?.step)) steps.set(session.id, event.data.step)
    if (event.type === 'turn/start' || event.type === 'turn/end') steps.delete(session.id)
  }
  // The reply rule (toast where the platform answers presses, else a chat notice) is shared with the forum bind Card.
  return { target: stopTarget, draft, widgetQuery, handles, unpaired, press, show, sourceOpen: open, sessionEvent, steps, reply }
}
