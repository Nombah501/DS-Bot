import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cardKinds } from '../src/host/im/card-kinds.js'
import { cardJournal } from '../src/host/im/cards.js'
import { imPlatform } from '../src/shared/im-platforms.js'

const chat = { key: '-60', kind: 'group' }
const ann = { id: '9', languageCode: 'en' }
const bob = { id: '10', languageCode: 'en' }
const text = key => `<${key}>`
const stale = () => Object.assign(new Error('Already answered'), { code: 'bot/stale' })
const bench = ({ platform = 'telegram', capabilities = {}, initiatorOf = async () => undefined, chats = [chat], languages } = {}) => {
  const conn = { id: 'one', platform, paired: [ann, bob], chats: Object.fromEntries(chats.map(address => [address.key, { kind: address.kind }])) }
  const connections = () => ({ [conn.id]: conn })
  const data = { cards: {} }
  const messages = []
  const edits = []
  const toasts = []
  const queue = []
  const pending = new Map()
  const denied = new Set()
  const origins = new Map()
  const claims = []
  const state = { questions: {}, secretRequests: {}, views: {} }
  const handle = {
    editCard: async (address, messageId, card) => { edits.push({ chat: address, messageId, card: structuredClone(card) }) },
    editPrivateCard: async (address, copy, card) => { edits.push({ chat: address, ephemeralMessageId: copy.ephemeralMessageId, card: structuredClone(card) }) },
    edit: async (address, messageId, content) => { edits.push({ chat: address, messageId, ...content }) },
  }
  const localized = language => key => `<${key}:${language}>`
  const textForChat = (_conn, chatKey) => languages === undefined ? text : localized(languages[chatKey])
  const textForPerson = (_conn, sender) => languages === undefined ? text : localized(sender.languageCode)
  let kinds
  const cards = cardJournal({
    store: { of: async () => data, peek: () => data, save: () => {} },
    connections,
    textForChat,
    textForPerson,
    handleOf: () => handle,
    deliveryOf: () => ({ output: (destination, content, callbacks) => { queue.push({ destination, content, ...callbacks }) } }),
    paired: (_conn, id) => conn.paired.some(person => person.id === id),
    sourceOpen: () => kinds.sourceOpen(),
    warn: error => { throw error },
    readOnly: () => false,
  })
  const rt = {
    state, chatOwners: new Map([['session', 'a']]), pastOwners: new Map(),
    botOf: () => ({ name: 'Alice' }), readOnly: () => undefined,
    chatOf: () => 'session',
    approvalsView: () => [...pending.values()],
    answerApproval: id => { if (!pending.delete(id)) throw stale() },
    answerQuestion: async (sessionId, id) => {
      if (state.questions[sessionId]?.id !== id) throw stale()
      delete state.questions[sessionId]
    },
    warn: error => { throw error },
  }
  kinds = cardKinds(rt, {
    cards, connections, handleOf: () => handle, running: () => true,
    place: {
      places: (_conn, target) => chats.map(chat => ({ chat, target })), initiatorOf,
      asked: async (_conn, requestId, sender, address) => { origins.set(requestId, { sender, address }) },
      unasked: async (_conn, requestId) => { origins.delete(requestId) },
      claimChat: (_conn, address, sender) => { claims.push({ address, sender }) },
      may: (_conn, id, target) => target !== undefined && !denied.has(id),
    },
    sendText: (_conn, address, body) => { messages.push({ chat: address, text: body }) },
    textForPerson,
    platformOf: id => ({ ...imPlatform(id), ...capabilities }),
  })
  let nextId = 700
  const deliver = async () => {
    while (queue.length) {
      const job = queue.shift()
      messages.push({ chat: job.destination.chat, ...structuredClone(job.content) })
      await job.sent({ messageId: nextId++, ...(job.content.receiverUserId === undefined ? {} : { ephemeralMessageId: 701 }) }, job.destination.chat)
    }
  }
  const question = async (id = 'question', multiSelect = false) => {
    state.questions.session = { id, question: 'Pick a colour', multiSelect, options: [{ label: 'Red' }, { label: 'Blue' }] }
    await kinds.sync(conn)
    await deliver()
  }
  const approval = async (id = 'approval') => {
    const entry = { id, botId: 'a', sessionId: 'session', tool: 'bash', reason: 'Inspect report' }
    pending.set(id, entry)
    await kinds.approval('open', entry)
    await deliver()
    return entry
  }
  const press = (data, sender = ann, extra = {}) => kinds.press(conn, { chat, sender, data, answer: body => { toasts.push(body) }, ...extra })
  const number = (body, sender = ann) => kinds.number(conn, { chat, sender, text: body })
  const clear = () => { messages.length = 0; edits.length = 0; toasts.length = 0 }
  return { conn, rt, state, kinds, pending, denied, messages, edits, toasts, origins, claims, deliver, question, approval, press, number, clear, reconcile: cards.settleGone }
}

test('Card kinds: an in-range number without Access is denied in chat and leaves the Card answerable', async () => {
  const b = bench()
  await b.question()
  b.denied.add(bob.id)
  b.clear()
  await b.number('1', bob)
  assert.deepEqual(b.messages.map(message => message.text), ['<denied>'])
  assert.deepEqual(b.toasts, [])
  assert.deepEqual(b.edits, [])
  await b.press('q:question:1')
  assert.deepEqual(b.edits.map(edit => edit.card.settled), [{ answer: 'Blue', options: [{ label: 'Blue' }] }])
})

test('Card kinds: a forged Private-card press answers privateOnly, not stale', async () => {
  const b = bench({ initiatorOf: async () => ({ sender: ann }) })
  await b.approval()
  b.clear()
  await b.press('a:approval:allow', bob, { ephemeralMessageId: 999, receiverUserId: bob.id })
  assert.deepEqual(b.toasts, ['<privateOnly>'])
  assert.deepEqual(b.messages, [])
  assert.deepEqual(b.edits, [])
  b.clear()
  await b.press('a:approval:allow', ann, { ephemeralMessageId: 999, receiverUserId: bob.id })
  assert.deepEqual(b.toasts, ['<privateOnly>'])
  assert.deepEqual(b.edits, [])
  await b.press('a:approval:allow', ann, { ephemeralMessageId: 701, receiverUserId: ann.id })
  assert.deepEqual(b.edits.map(edit => edit.card.settled.answer), ['<allow>'])
})

test('Card kinds: a number skips another Initiator’s Private card for an older public Card or the Bot', async () => {
  for (const publicCard of [true, false]) {
    const b = bench({ initiatorOf: async () => ({ sender: ann }) })
    if (publicCard) await b.question()
    await b.approval()
    b.clear()
    const answered = await b.number('1', bob)
    assert.deepEqual(b.messages, [])
    assert.deepEqual(b.toasts, [])
    assert.equal(answered, publicCard)
    assert.deepEqual(b.edits.map(edit => edit.card.settled), publicCard ? [{ answer: 'Red', options: [{ label: 'Red' }] }] : [])
    await b.press('a:approval:allow', ann, { ephemeralMessageId: 701, receiverUserId: ann.id })
    assert.equal(b.edits.at(-1).card.settled.answer, '<allow>')
  }
})

test('Card kinds: an approval recorded after settlement during initiatorOf is claimed and every copy edited on stale press', async () => {
  const entered = Promise.withResolvers()
  const released = Promise.withResolvers()
  const b = bench({
    chats: [chat, { key: '-61', kind: 'group' }],
    initiatorOf: () => { entered.resolve(); return released.promise },
  })
  const opening = b.approval()
  await entered.promise
  b.pending.clear()
  await b.kinds.approval('settled', { id: 'approval', outcome: 'allowed-once' })
  released.resolve(undefined)
  await opening
  b.clear()
  await b.press('a:approval:allow')
  assert.deepEqual(b.toasts, ['<stale>'])
  assert.deepEqual(b.edits.map(edit => [edit.chat.key, edit.card.settled]), [
    ['-60', { answer: '<answered>', options: [] }],
    ['-61', { answer: '<answered>', options: [] }],
  ])
  b.clear()
  await b.press('a:approval:reject')
  assert.deepEqual(b.toasts, ['<stale>'])
  assert.deepEqual(b.edits, [])
})

test('Card kinds: Access denial precedes Private-card feedback for buttons and approvals deny numbers in chat', async () => {
  const b = bench({ initiatorOf: async () => ({ sender: ann }) })
  await b.approval()
  b.denied.add(ann.id)
  b.clear()
  await b.press('a:approval:allow', ann, { ephemeralMessageId: 999, receiverUserId: bob.id })
  assert.deepEqual(b.toasts, ['<denied>'])
  assert.deepEqual(b.messages, [])
  b.clear()
  await b.number('2')
  assert.deepEqual(b.messages.map(message => message.text), ['<denied>'])
  assert.deepEqual(b.toasts, [])
  assert.deepEqual(b.edits, [])
})

test('Card kinds: multi-select toggles redraw, empty Done replies, and numbers ignore toggles', async () => {
  const b = bench()
  await b.question('question:multi', true)
  b.clear()
  await b.press('m:question:multi:done')
  assert.deepEqual(b.toasts, ['<selectOne>'])
  assert.deepEqual(b.edits, [])
  await b.press('m:question:multi:0')
  assert.deepEqual(b.edits.at(-1).card.options.map(option => option.checked), [true, false, undefined])
  await b.number('2')
  assert.deepEqual(b.edits.at(-1).card.settled, { answer: 'Blue', options: [{ label: 'Blue' }] })
  b.clear()
  await b.press('m:question:multi:done')
  assert.deepEqual(b.toasts, ['<stale>'])
  assert.deepEqual(b.edits, [])
})

test('Card kinds: Done answers selected multi-select options and source-side question claims can roll back', async () => {
  const b = bench()
  await b.question('question', true)
  b.clear()
  await b.press('m:question:1')
  await b.press('m:question:done')
  assert.deepEqual(b.edits.at(-1).card.settled, { answer: 'Blue', options: [{ label: 'Blue' }] })
  await b.question('next', true)
  b.clear()
  const rollback = b.kinds.questionClaimed(b.state.questions.session, { selected: ['Red', 'Red', 'not an option'] })
  await b.kinds.questionAnswered()
  assert.deepEqual(b.edits.at(-1).card.settled, { answer: 'Red', options: [{ label: 'Red' }] })
  await rollback()
  assert.equal(b.edits.at(-1).card.settled, undefined)
  assert.deepEqual(b.edits.at(-1).card.options.map(option => option.label), ['Red', 'Blue', '<done>'])
})

test('Card kinds: non-Telegram buttons, numbers, edits and stale feedback follow platform capabilities', async () => {
  const b = bench({ platform: 'feishu', capabilities: { buttons: true, richCards: false, callbackAnswer: false } })
  await b.question()
  assert.deepEqual(b.messages[0].buttons, [{ data: 'q:question:0', label: 'Red' }, { data: 'q:question:1', label: 'Blue' }])
  assert.equal(b.messages[0].card, undefined)
  b.clear()
  await b.press('q:question:1')
  assert.match(b.edits.at(-1).text, /\n— Blue$/)
  b.clear()
  await b.press('q:question:1')
  assert.deepEqual(b.messages.map(message => message.text), ['<stale>'])
  assert.deepEqual(b.toasts, [])
  await b.approval()
  b.clear()
  await b.number('2')
  assert.match(b.edits.at(-1).text, /\n— <reject>$/)
  b.clear()
  await b.press('a:approval:allow')
  assert.deepEqual(b.messages.map(message => message.text), ['<stale>'])
  assert.deepEqual(b.toasts, [])
})

test('Card kinds: out-of-range and stale numbers reach the Bot, while malformed presses stay silent', async () => {
  const b = bench()
  await b.question()
  b.clear()
  for (const value of ['0', '3', '1 2', 'not a number']) assert.equal(await b.number(value), false)
  delete b.state.questions.session
  assert.equal(await b.number('1'), false)
  for (const data of ['q:', 'm:', 'a:', 'a:missing:invalid', 'unknown:1:0']) await b.press(data)
  assert.deepEqual(b.messages, [])
  assert.deepEqual(b.toasts, [])
  assert.deepEqual(b.edits, [])
})

test('Card kinds: secret requests and views render as notices and settle when their sources leave', async () => {
  const b = bench()
  b.state.secretRequests.a = [{ id: 'secret', name: 'TEST_KEY', status: 'pending' }]
  b.state.views.session = { id: 'view', title: 'Computer form', view: {} }
  await b.kinds.sync(b.conn)
  await b.deliver()
  assert.deepEqual(b.messages.map(message => message.text), ['<secretAsk>', '<viewShow>\nComputer form'])
  assert.equal(b.messages.some(message => message.buttons !== undefined || message.card !== undefined), false)
  b.clear()
  b.state.secretRequests.a[0].status = 'provided'
  delete b.state.views.session
  await b.reconcile()
  assert.deepEqual(b.edits.map(edit => edit.text), ['<secretAsk>\n— <answered>', '<viewShow>\nComputer form\n— <answered>'])
})

test('Card kinds: source-side approval settlement edits the chosen option and rejects later presses', async () => {
  const b = bench()
  const entry = await b.approval()
  b.clear()
  b.pending.clear()
  const settled = b.kinds.approval('settled', { ...entry, outcome: 'rejected' })
  await b.press('a:approval:allow')
  await settled
  assert.deepEqual(b.toasts, ['<stale>'])
  assert.deepEqual(b.edits.map(edit => edit.card.settled), [{ answer: '<reject>', options: [{ label: '<reject>', style: 'danger' }] }])
})

for (const kind of ['question', 'approval']) {
  test(`Card kinds: a source-stale ${kind} settles every copy in its own language`, async () => {
    const privateApproval = kind === 'approval'
    const b = bench({
      chats: [chat, { key: '-61', kind: privateApproval ? 'direct' : 'group' }],
      languages: { '-60': privateApproval ? 'ru' : 'en', '-61': privateApproval ? 'en' : 'ru' },
      initiatorOf: async () => privateApproval ? { sender: { ...ann, languageCode: 'ru' } } : undefined,
    })
    if (privateApproval) {
      await b.approval()
      b.pending.clear()
    } else {
      await b.question()
      b.rt.answerQuestion = async () => { throw stale() }
    }
    b.clear()
    await b.press(privateApproval ? 'a:approval:allow' : 'q:question:0', ann,
      privateApproval ? { ephemeralMessageId: 701, receiverUserId: ann.id } : {})
    assert.deepEqual(b.toasts, ['<stale:en>'])
    assert.deepEqual(b.edits.map(edit => [edit.chat.key, edit.card.settled.answer]), [
      ['-60', privateApproval ? '<answered:ru>' : '<answered:en>'],
      ['-61', privateApproval ? '<answered:en>' : '<answered:ru>'],
    ])
  })
}

test('Card kinds: a question answer registers its Origin before passing the continuation request id', async () => {
  const b = bench()
  await b.question()
  let continued
  b.rt.answerQuestion = async (sessionId, id, answer, requestId) => {
    continued = { sessionId, id, answer, requestId }
    assert.deepEqual(b.origins.get(requestId), { sender: ann, address: chat })
    delete b.state.questions[sessionId]
  }
  await b.press('q:question:0')
  assert.match(continued.requestId, /^im:telegram:/)
  assert.deepEqual(continued.answer, { selected: ['Red'] })
})

test('Card kinds: stale question answers release their request and stale approvals never claim a chat', async () => {
  const b = bench()
  await b.question()
  b.rt.answerQuestion = async () => { throw stale() }
  await b.press('q:question:0')
  assert.equal(b.origins.size, 0)
  await b.approval()
  b.rt.answerApproval = () => { throw stale() }
  await b.press('a:approval:allow')
  assert.deepEqual(b.claims, [])
})

test('Card kinds: reconciliation sends an approval opened while disconnected once', async () => {
  const b = bench()
  b.pending.set('waiting', { id: 'waiting', botId: 'a', sessionId: 'session', tool: 'bash' })
  await b.kinds.sync(b.conn)
  await b.deliver()
  assert.equal(b.messages.filter(message => /bash/.test(message.card?.text ?? message.text ?? '')).length, 1)
  await b.kinds.sync(b.conn)
  await b.deliver()
  assert.equal(b.messages.length, 1)
})
