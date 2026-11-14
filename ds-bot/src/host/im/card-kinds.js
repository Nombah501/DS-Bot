// DSH-sourced Card kinds: their rendering, answers and source-side settlement.
// The journal beneath this module stays kind-agnostic.
import { viewCardText } from '../parts.js'
import { imPlatform } from '../../shared/im-platforms.js'

export const NUMBERS = /^\s*\d+(\s+\d+)*\s*$/

export function cardKinds(rt, { cards, place, connections, handleOf, running, sendText, textForPerson, platformOf = imPlatform }) {
  const { state } = rt
  const reply = async (conn, chat, body, action) => {
    if (platformOf(conn.platform)?.callbackAnswer === true && typeof action?.answer === 'function') return action.answer(body)
    return sendText(conn, chat, body)
  }
  const questionById = id => {
    for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
      if (question.id === id) return { sessionId, question }
    }
    return undefined
  }
  const answerQuestion = async (conn, chat, cardKey, labels, sender, action) => {
    const text = textForPerson(conn, sender)
    const held = cards.open(conn, chat, cardKey)
    if (held === undefined) return false
    const found = questionById(held.cardKey.slice(2))
    if (found === undefined) {
      await reply(conn, chat, text('stale'), action)
      return true
    }
    const valid = labels.filter(label => (found.question.options ?? []).some(option => option.label === label))
    if (valid.length === 0) return false
    try {
      await rt.answerQuestion(found.sessionId, found.question.id, { selected: valid })
      await cards.settle(conn, held.cardKey, valid.join(', '))
    } catch (error) {
      if (error?.code === 'bot/stale') {
        await cards.claim(conn, held.cardKey, text => text('answered'))
        await reply(conn, chat, text('stale'), action)
        await cards.edits(conn)
        return true
      }
      throw error
    }
    return true
  }
  const answerApproval = async (conn, chat, cardKey, choice, sender, action) => {
    const text = textForPerson(conn, sender)
    const held = cards.open(conn, chat, cardKey)
    if (held === undefined) return false
    try {
      rt.answerApproval(held.cardKey.slice(2), choice)
      await cards.settle(conn, held.cardKey, text => choice === 'allow' ? text('allow') : text('reject'))
    } catch (error) {
      if (error?.code === 'bot/stale') {
        await cards.claim(conn, held.cardKey, text => text('answered'))
        await reply(conn, chat, text('stale'), action)
        await cards.edits(conn)
        return true
      }
      throw error
    }
    return true
  }
  const press = async (conn, action) => {
    const text = textForPerson(conn, action.sender)
    const data = String(action.data ?? '')
    const { chat } = action
    // An id may contain colons; only the final colon separates the choice.
    const cut = data.lastIndexOf(':')
    const cardKey = data.slice(0, cut)
    const choice = data.slice(cut + 1)
    if (cut <= 2 || !['q:', 'm:', 'a:'].some(prefix => data.startsWith(prefix))) return
    if (data.startsWith('a:') && choice !== 'allow' && choice !== 'reject') return
    if (data.startsWith('m:') && platformOf(conn.platform)?.richCards !== true) return
    const key = data.startsWith('m:') ? `q:${cardKey.slice(2)}` : cardKey
    const refusal = outcome(conn, chat, key, action.sender, action)
    if (refusal !== undefined) {
      await reply(conn, chat, text(refusal), action)
      return
    }
    if (data.startsWith('m:')) {
      const held = cards.open(conn, chat, key)
      const found = questionById(cardKey.slice(2))
      const handle = handleOf(conn.id)
      if (found?.question.multiSelect !== true || held?.entry.card === undefined || handle === undefined) {
        await reply(conn, chat, text('stale'), action)
        return
      }
      const { entry } = held
      if (choice === 'done') {
        const selected = entry.card.options.filter(option => option.checked === true).map(option => option.label)
        if (selected.length === 0) {
          await reply(conn, chat, text('selectOne'), action)
          return
        }
        if (!(await answerQuestion(conn, chat, key, selected, action.sender, action))) await reply(conn, chat, text('stale'), action)
        return
      }
      const option = /^\d+$/.test(choice) ? entry.card.options[Number(choice)] : undefined
      if (option?.checked === undefined || option.data !== data) return
      option.checked = !option.checked
      await cards.redraw(conn, chat, entry)
      return
    }
    if (data.startsWith('q:')) {
      const found = questionById(cardKey.slice(2))
      const label = found?.question.options?.[Number(choice)]?.label
      if (label === undefined) {
        await reply(conn, chat, text('stale'), action)
        return
      }
      if (!(await answerQuestion(conn, chat, cardKey, [label], action.sender, action))) await reply(conn, chat, text('stale'), action)
      return
    }
    if (data.startsWith('a:')) {
      if (!(await answerApproval(conn, chat, cardKey, choice, action.sender, action))) await reply(conn, chat, text('stale'), action)
    }
  }
  const outcome = (conn, chat, cardKey, sender, action) => {
    // Inspect the chat's copy before validating Private-card callback metadata.
    const held = cards.open(conn, chat, cardKey)
    if (held !== undefined && !place.may(conn, sender.id, held.entry.target)) return 'denied'
    if (held === undefined) return 'stale'
    const { entry } = held
    if (entry.receiverUserId !== undefined && (sender.id !== entry.receiverUserId
      || (action !== undefined && (action.ephemeralMessageId !== entry.ephemeralMessageId || action.receiverUserId !== entry.receiverUserId)))) return 'privateOnly'
    return undefined
  }
  const number = async (conn, msg) => {
    const body = String(msg.text ?? '').trim()
    if (!NUMBERS.test(body)) return false
    const picked = body.split(/\s+/).map(Number)
    const held = cards.newest(conn, msg.chat, cardKey => {
      if (!cardKey.startsWith('q:') && !cardKey.startsWith('a:')) return false
      const receiver = cards.open(conn, msg.chat, cardKey)?.entry.receiverUserId
      return receiver === undefined || receiver === msg.sender.id
    })
    if (held === undefined) return false
    // Out-of-range picks and stale sources continue to the Bot as ordinary messages.
    let labels
    let choice
    if (held.cardKey.startsWith('q:')) {
      const found = questionById(held.cardKey.slice(2))
      if (found === undefined) return false
      const options = found.question.options ?? []
      if ((found.question.multiSelect !== true && picked.length !== 1) || !picked.every(index => options[index - 1] !== undefined)) return false
      labels = picked.map(index => options[index - 1].label)
    } else {
      if (picked.length !== 1 || (picked[0] !== 1 && picked[0] !== 2)
        || !rt.approvalsView().some(entry => `a:${entry.id}` === held.cardKey)) return false
      choice = picked[0] === 1 ? 'allow' : 'reject'
    }
    const refusal = outcome(conn, msg.chat, held.cardKey, msg.sender)
    if (refusal !== undefined) {
      await reply(conn, msg.chat, textForPerson(conn, msg.sender)(refusal))
      return true
    }
    return labels !== undefined
      ? answerQuestion(conn, msg.chat, held.cardKey, labels, msg.sender)
      : answerApproval(conn, msg.chat, held.cardKey, choice, msg.sender)
  }

  const cardText = {
    question: (bot, question, text) => {
      const options = (question.options ?? []).map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')
      const hint = question.multiSelect === true ? text('numbersMulti') : text('numbers')
      return `${text('question', { bot })}${question.question}${question.detail ? `\n${question.detail}` : ''}\n${options}\n(${hint})`
    },
    approval: (bot, entry, text) => `${text('approval', { bot })}${entry.tool}${entry.reason ? ` — ${entry.reason}` : ''}${entry.detail?.text ? `\n${entry.detail.text}` : ''}${entry.detail?.code ? `\n${entry.detail.code}` : ''}`,
  }
  const cardButtons = {
    question: question => question.multiSelect === true ? undefined : (question.options ?? []).map((option, index) => ({ data: `q:${question.id}:${index}`, label: option.label })),
    multiSelect: (question, text) => [
      ...(question.options ?? []).map((option, index) => ({ data: `m:${question.id}:${index}`, label: option.label, checked: false })),
      { data: `m:${question.id}:done`, label: text('done'), submit: true },
    ],
    approval: (id, text) => [{ data: `a:${id}:allow`, label: text('allow') }, { data: `a:${id}:reject`, label: text('reject') }],
  }
  const sync = async conn => {
    if (rt.readOnly() !== undefined || !running(conn.id)) return
    await cards.load(conn.id)
    for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
      const cardKey = `q:${question.id}`
      if (cards.sent(conn.id, cardKey)) continue
      const botId = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId
      const bot = rt.botOf(botId)
      if (bot === undefined) continue
      const buttons = platformOf(conn.platform)?.buttons === true ? cardButtons.question(question) : undefined
      await cards.send(conn, cardKey, place.places(conn, { botId }, sessionId, 'card'), text => cardText.question(bot.name, question, text), buttons,
        text => ({ text: cardText.question(bot.name, question, text), options: question.multiSelect === true ? cardButtons.multiSelect(question, text) : cardButtons.question(question) }))
    }
    // Secret requests: text only — the key is typed on the computer or phone.
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      const bot = rt.botOf(botId)
      if (bot === undefined) continue
      for (const request of list) {
        const cardKey = `s:${request.id}`
        if (request.status !== 'pending' || cards.sent(conn.id, cardKey)) continue
        await cards.send(conn, cardKey, place.places(conn, { botId }, request.sessionId, 'card'), text => text('secretAsk', { bot: bot.name, name: request.name }))
      }
    }
    for (const [sessionId, view] of Object.entries(state.views ?? {})) {
      const cardKey = `v:${view.id}`
      if (cards.sent(conn.id, cardKey)) continue
      const botId = rt.chatOwners.get(sessionId)
      const bot = rt.botOf(botId)
      if (bot === undefined) continue
      const form = viewCardText({ title: view.title, view: view.view })
      await cards.send(conn, cardKey, place.places(conn, { botId }, sessionId, 'card'), text => `${text('viewShow', { bot: bot.name })}${form !== '' ? `\n${form}` : view.title ? `\n${view.title}` : ''}`)
    }
  }
  const sourceOpen = () => {
    const questions = new Set(Object.values(state.questions ?? {}).map(question => `q:${question.id}`))
    const secrets = new Set(Object.values(state.secretRequests ?? {}).flat().filter(entry => entry.status === 'pending').map(entry => `s:${entry.id}`))
    const views = new Set(Object.values(state.views ?? {}).map(view => `v:${view.id}`))
    return cardKey => cardKey.startsWith('q:') ? questions.has(cardKey)
      : cardKey.startsWith('a:') ? rt.approvalsView().some(entry => `a:${entry.id}` === cardKey)
        : cardKey.startsWith('s:') ? secrets.has(cardKey)
          : cardKey.startsWith('v:') ? views.has(cardKey) : false
  }
  const approval = (kind, data) => {
    if (kind === 'open') {
      return (async () => {
        for (const conn of Object.values(connections())) {
          if (!running(conn.id)) continue
          const bot = rt.botOf(data.botId)
          const targets = place.places(conn, data.roomId === undefined ? { botId: data.botId } : { roomId: data.roomId }, data.sessionId, 'card')
          const buttons = platformOf(conn.platform)?.buttons === true ? text => cardButtons.approval(data.id, text) : undefined
          const initiator = await place.initiatorOf(conn, data.sessionId)
          await cards.send(conn, `a:${data.id}`, targets, text => cardText.approval(bot?.name ?? '?', data, text), buttons,
            text => ({
              text: cardText.approval(bot?.name ?? '?', { ...data, detail: undefined }, text),
              details: data.detail,
              options: cardButtons.approval(data.id, text).map((option, index) => ({ ...option, style: index === 0 ? 'success' : 'danger' })),
            }), initiator)
        }
      })().catch(error => rt.warn('ds-bot: im approval card failed: %s', error))
    }
    const conns = Object.values(connections())
    for (const conn of conns) {
      cards.claim(conn, `a:${data.id}`, text => data.outcome === 'allowed-once' ? text('allow') : data.outcome === 'rejected' ? text('reject') : text('answered'))
    }
    return (async () => {
      for (const conn of conns) await cards.edits(conn)
    })().catch(() => {})
  }
  const questionClaimed = (question, answer) => {
    const selected = (answer?.selected ?? []).filter(label => question.options?.some(option => option.label === label))
    const labels = question.multiSelect === true ? [...new Set(selected)] : selected.slice(0, 1)
    const rollbacks = []
    for (const conn of Object.values(connections())) {
      if (platformOf(conn.platform)?.richCards !== true) continue
      const rollback = cards.claim(conn, `q:${question.id}`, labels.length ? labels.join(', ') : text => text('answered'), labels)
      if (rollback !== undefined) rollbacks.push(rollback)
    }
    return () => Promise.all(rollbacks.map(rollback => rollback()))
  }
  const questionAnswered = async () => {
    for (const conn of Object.values(connections())) {
      if (platformOf(conn.platform)?.richCards !== true) continue
      await cards.edits(conn)
    }
  }
  return { press, number, sync, sourceOpen, approval, questionClaimed, questionAnswered }
}
