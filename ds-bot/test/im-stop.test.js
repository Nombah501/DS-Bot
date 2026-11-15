import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stops } from '../src/host/im/stop.js'
import { inbound } from '../src/host/im/inbound.js'
import { allows } from '../src/host/im/topics.js'

const chat = { key: 'dm', kind: 'direct', threadId: 7 }
const sender = { id: 'ann', languageCode: 'ru' }
const text = language => key => `<${key}:${language}>`
const bench = ({ capabilities = { drafts: true, statusPanel: true, richCards: true, callbackAnswer: true }, target = { botId: 'a' }, stopped = true, stopping } = {}) => {
  const conn = {
    id: 'c1', platform: 'fake', botId: 'a', requests: [],
    paired: [{ id: 'ann', access: 'all' }, { id: 'denied', access: { botIds: [], roomIds: [] } }],
    chats: { dm: { kind: 'direct', personId: 'ann', languageCode: 'de', target } },
  }
  const calls = []
  const notices = []
  const toasts = []
  const outputs = []
  const sent = []
  const edited = []
  const entries = [{ chatKey: chat.key, threadId: chat.threadId, messageId: 42, target }]
  const copy = { chat: { ...chat }, target, draftId: 12 }
  const panel = { chat: { ...chat }, target, messageId: 42 }
  const textForPerson = (current, person) => text(current.paired.find(entry => entry.id === person?.id)?.language ?? person?.languageCode ?? 'en')
  const textForChat = (current, key) => textForPerson(current, { id: current.chats[key]?.personId, languageCode: current.chats[key]?.languageCode })
  const rt = {
    live: new Map([['a', { turn: 1 }], ['ar1', { turn: 1 }]]), state: {},
    chatOf: id => id, botOf: () => ({ name: 'Chief' }),
    roomOf: () => ({ name: 'Ops', sessions: { a: 'ar1', b: 'br1' } }),
    approvalsView: () => [], save: async () => {},
    stopChat: async id => { calls.push(['stopChat', id]); await stopping?.(); return stopped },
    stopRoomWork: async id => { calls.push(['stopRoomWork', id]); await stopping?.(); return stopped },
  }
  const place = {
    targetOf: (current, address) => { calls.push(['target']); return current.chats[address.key]?.target },
    may: (current, id, value) => { calls.push(['may', id]); return allows(current.paired.find(person => person.id === id), value) },
    deliverable: (_conn, address, { target: value }) => {
      calls.push(['deliverable'])
      const current = conn.chats[address.key]?.target
      return address.threadId === chat.threadId && current?.botId === value.botId && current?.roomId === value.roomId
    },
  }
  const claim = (_conn, key, answer, selected) => {
    calls.push(['claim', key, selected])
    for (const entry of entries) if (entry.answer === undefined) entry.answer = answer(textForChat(conn, entry.chatKey))
  }
  const cards = {
    byMessage: (_conn, address, key, messageId) => {
      calls.push(['byMessage'])
      return key === 't:snapshot:with-colon' ? entries.find(entry => entry.chatKey === address.key && entry.threadId === address.threadId && entry.messageId === messageId) : undefined
    },
    claim,
    edits: async () => { calls.push(['edits']); edited.push(entries.map(entry => entry.answer)) },
    settle: async (...args) => { calls.push(['settle']); claim(...args); await cards.edits(conn) },
    send: async (...args) => { sent.push(args) },
  }
  const runner = {
    handle: {},
    drafts: {
      find: (address, id) => {
        calls.push(['findDraft'])
        return id === copy.draftId && address.key === copy.chat.key && address.threadId === copy.chat.threadId ? copy : undefined
      },
      endTarget: value => { calls.push(['endDrafts', value]) },
    },
    panels: { find: (key, id) => { calls.push(['findPanel']); return key === panel.chat.key && id === panel.messageId ? panel : undefined } },
    delivery: { output: (...args) => { outputs.push(args) } },
  }
  const sendText = (_conn, address, body) => { calls.push(['notice', body]); notices.push({ chat: address, text: body }) }
  const stop = stops(rt, {
    cards, place, runnerOf: () => runner, sendText, textForPerson, textForChat,
    sourceOpen: () => key => key === 'q:open', platformOf: () => capabilities,
  })
  // /stop's pairing and early Access gates belong to Inbound, before the shared Stop.
  const incoming = inbound(rt, {
    records: { arrived: async () => ({ conn, chat: conn.chats.dm }) }, place,
    connections: () => ({ c1: conn }), deliveryOf: () => ({ notice: (address, body) => sendText(conn, address, body.text) }),
    stopTarget: stop.target, showStatus: stop.show, textForPerson, platformOf: () => capabilities,
  })
  const action = (extra = {}) => ({ chat, sender, data: 't:snapshot:with-colon:stop', messageId: 42, answer: async body => { calls.push(['toast', body]); toasts.push(body) }, ...extra })
  return {
    stop, rt, conn, calls, notices, toasts, outputs, sent, edited, entries, copy, panel, runner, cards, place, capabilities, action,
    command: (extra = {}) => incoming.message(conn, { chat, sender, text: '/stop', ...extra }),
  }
}

for (const target of [{ botId: 'a' }, { roomId: 'r1' }]) {
  test(`Stop: /stop ends Drafts before stopping ${Object.keys(target)[0]} and replies in the sender language`, async () => {
    const b = bench({ target })
    await b.command()
    assert.deepEqual(b.calls.slice(-3), [['endDrafts', target], [target.botId ? 'stopChat' : 'stopRoomWork', target.botId ?? target.roomId], ['notice', '<stopped:ru>']])
    assert.deepEqual(b.notices, [{ chat, text: '<stopped:ru>' }])
    assert.deepEqual(b.toasts, [])
  })
}

test('Stop: /stop without Access or pairing never reaches the shared Stop', async () => {
  for (const [id, reply] of [['denied', '<denied:ru>'], ['unknown', '<requested:ru>']]) {
    const b = bench()
    await b.command({ sender: { id, languageCode: 'ru' } })
    assert.deepEqual(b.calls.filter(call => ['stopChat', 'stopRoomWork', 'endDrafts'].includes(call[0])), [])
    assert.deepEqual(b.notices, [{ chat, text: reply }])
  }
})

test('Stop: an idle /stop replies idle in the sender language', async () => {
  const b = bench({ stopped: false })
  await b.command()
  assert.deepEqual(b.notices, [{ chat, text: '<idle:ru>' }])
})

test('Stop: Draft Stop checks the copy, chat target and owner before stopping in the chat language', async () => {
  const b = bench()
  await b.stop.draft(b.conn, { chat, draftId: 12 })
  assert.deepEqual(b.calls, [['findDraft'], ['target'], ['may', 'ann'], ['endDrafts', { botId: 'a' }], ['stopChat', 'a'], ['notice', '<stopped:de>']])
  assert.deepEqual(b.notices, [{ chat: b.copy.chat, text: '<stopped:de>' }])
})

for (const reason of ['capability', 'group', 'zero', 'unsafe', 'missing copy', 'wrong Topic', 'no Access', 'unpaired', 'another target', 'unbound']) {
  test(`Stop: Draft Stop silently ignores ${reason}`, async () => {
    const b = bench()
    const event = { chat, draftId: 12 }
    if (reason === 'capability') b.capabilities.drafts = false
    if (reason === 'group') event.chat = { ...chat, kind: 'group' }
    if (reason === 'zero') event.draftId = 0
    if (reason === 'unsafe') event.draftId = 1.5
    if (reason === 'missing copy') event.draftId = 13
    if (reason === 'wrong Topic') event.chat = { ...chat, threadId: 8 }
    if (reason === 'no Access') b.conn.chats.dm.personId = 'denied'
    if (reason === 'unpaired') b.conn.paired = []
    if (reason === 'another target') b.copy.target = { botId: 'b' }
    if (reason === 'unbound') delete b.conn.chats.dm
    await b.stop.draft(b.conn, event)
    assert.deepEqual(b.calls.filter(call => ['endDrafts', 'stopChat', 'stopRoomWork', 'notice'].includes(call[0])), [])
    assert.deepEqual(b.toasts, [])
  })
}

test('Stop: an idle Draft Stop still ends Drafts and answers in the chat language', async () => {
  const b = bench({ stopped: false })
  await b.stop.draft(b.conn, { chat, draftId: 12 })
  assert.deepEqual(b.calls.slice(-3), [['endDrafts', { botId: 'a' }], ['stopChat', 'a'], ['notice', '<idle:de>']])
})

for (const [languageCode, expected] of [['ru', 'ru'], [undefined, 'de']]) {
  test(`Stop: widget Stop answers in ${languageCode ? 'the presser language' : 'the chat fallback language'} as a chat notice`, async () => {
    const b = bench({ target: { roomId: 'r1' } })
    await b.stop.widgetQuery(b.conn, b.action({ type: 'data', data: 'stop', sender: { id: 'ann', languageCode } }))
    assert.deepEqual(b.calls, [['findPanel'], ['may', 'ann'], ['endDrafts', { roomId: 'r1' }], ['stopRoomWork', 'r1'], ['notice', `<stopped:${expected}>`]])
    assert.deepEqual(b.notices, [{ chat: b.panel.chat, text: `<stopped:${expected}>` }])
    assert.deepEqual(b.toasts, [])
  })
}

for (const reason of ['capability', 'group', 'wrong type', 'wrong data', 'unpaired', 'missing panel', 'no Access']) {
  test(`Stop: widget Stop silently ignores ${reason}`, async () => {
    const b = bench()
    const action = b.action({ type: 'data', data: 'stop' })
    if (reason === 'capability') b.capabilities.statusPanel = false
    if (reason === 'group') action.chat = { ...chat, kind: 'group' }
    if (reason === 'wrong type') action.type = 'message'
    if (reason === 'wrong data') action.data = 'other'
    if (reason === 'unpaired') action.sender = { id: 'unknown' }
    if (reason === 'missing panel') action.messageId = 43
    if (reason === 'no Access') action.sender = { id: 'denied' }
    await b.stop.widgetQuery(b.conn, action)
    assert.deepEqual(b.calls.filter(call => ['endDrafts', 'stopChat', 'stopRoomWork', 'notice', 'toast'].includes(call[0])), [])
  })
}

test('Stop: an idle widget Stop answers idle using the presser preference over the device language', async () => {
  const b = bench({ stopped: false })
  b.conn.paired[0].language = 'fr'
  await b.stop.widgetQuery(b.conn, b.action({ type: 'data', data: 'stop' }))
  assert.deepEqual(b.notices, [{ chat: b.panel.chat, text: '<idle:fr>' }])
  assert.deepEqual(b.toasts, [])
})

for (const kind of ['direct', 'group']) {
  test(`Stop: ${kind} snapshot claims every copy before Stop yields and a second press cannot stop twice`, async () => {
    const gate = Promise.withResolvers()
    const entered = Promise.withResolvers()
    const b = bench({ stopping: () => { entered.resolve(); return gate.promise } })
    b.entries.push({ ...b.entries[0], messageId: 43 })
    const action = b.action({ chat: { ...chat, kind } })
    const first = b.stop.press(b.conn, action)
    assert.equal(b.entries[0].answer, '<stopped:de>')
    assert.equal(b.entries[1].answer, '<stopped:de>')
    await entered.promise
    try {
      await b.stop.press(b.conn, action)
      assert.deepEqual(b.toasts, ['<idle:ru>'])
      assert.equal(b.calls.filter(call => call[0] === 'stopChat').length, 1)
    } finally { gate.resolve() }
    await first
    assert.deepEqual(b.toasts, ['<idle:ru>', '<stopped:ru>'])
    assert.deepEqual(b.calls.slice(0, 6), [['byMessage'], ['may', 'ann'], ['deliverable'], ['claim', 't:snapshot:with-colon', []], ['endDrafts', { botId: 'a' }], ['stopChat', 'a']])
    assert.deepEqual(b.edited, [['<stopped:de>', '<stopped:de>'], ['<stopped:de>', '<stopped:de>']])
    assert.deepEqual(b.notices, [])
  })
}

for (const reason of ['unpaired', 'no Access', 'rebound']) {
  test(`Stop: snapshot ${reason} answers denied in the presser language without stopping`, async () => {
    const b = bench()
    const action = b.action()
    if (reason === 'unpaired') action.sender = { id: 'unknown', languageCode: 'ru' }
    if (reason === 'no Access') action.sender = { id: 'denied', languageCode: 'ru' }
    if (reason === 'rebound') b.conn.chats.dm.target = { botId: 'b' }
    if (reason === 'unpaired') await b.stop.unpaired(b.conn, action)
    else await b.stop.press(b.conn, action)
    assert.deepEqual(b.toasts, ['<denied:ru>'])
    assert.deepEqual(b.notices, [])
    assert.deepEqual(b.edited, [])
    assert.equal(b.entries[0].answer, undefined)
    assert.equal(b.calls.some(call => call[0] === 'stopChat'), false)
    if (reason === 'unpaired') assert.deepEqual(b.calls, [['toast', '<denied:ru>']])
  })
}

for (const reason of ['missing message', 'wrong Topic', 'wrong chat kind', 'wrong choice', 'answered', 'inactive']) {
  test(`Stop: snapshot ${reason} answers idle without stopping`, async () => {
    const b = bench()
    const action = b.action()
    if (reason === 'missing message') action.messageId = 43
    if (reason === 'wrong Topic') action.chat = { ...chat, threadId: 8 }
    if (reason === 'wrong chat kind') action.chat = { ...chat, kind: 'channel' }
    if (reason === 'wrong choice') action.data = 't:snapshot:with-colon:other'
    if (reason === 'answered') b.entries[0].answer = '<stopped:de>'
    if (reason === 'inactive') b.rt.live.clear()
    await b.stop.press(b.conn, action)
    assert.deepEqual(b.toasts, ['<idle:ru>'])
    assert.equal(b.calls.some(call => call[0] === 'stopChat'), false)
    assert.deepEqual(b.notices, [])
    assert.deepEqual(b.edited, reason === 'answered' ? [['<stopped:de>']] : reason === 'inactive' ? [['<idle:de>']] : [])
    if (reason === 'answered' || reason === 'inactive') assert.ok(b.calls.findIndex(call => call[0] === 'edits') < b.calls.findIndex(call => call[0] === 'toast'))
  })
}

test('Stop: snapshot toast falls back to a chat message by callbackAnswer capability or absent answer', async () => {
  for (const variant of ['no capability', 'no answer']) {
    const b = bench()
    const action = b.action()
    if (variant === 'no capability') b.capabilities.callbackAnswer = false
    else delete action.answer
    await b.stop.press(b.conn, action)
    assert.deepEqual(b.notices, [{ chat, text: '<stopped:ru>' }])
    assert.deepEqual(b.toasts, [])
    assert.deepEqual(b.edited, [['<stopped:de>']])
  }
})

test('Stop: snapshot keeps its stopped label if the turn ends between the activity check and Stop', async () => {
  const b = bench({ stopped: false })
  await b.stop.press(b.conn, b.action())
  assert.deepEqual(b.toasts, ['<idle:ru>'])
  assert.deepEqual(b.edited, [['<stopped:de>']])
})

test('Stop: routing accepts only t: snapshots on statusPanel platforms', async () => {
  const b = bench()
  assert.equal(b.stop.handles(b.conn, b.action()), true)
  assert.equal(b.stop.handles(b.conn, b.action({ data: 'q:question:0' })), false)
  b.capabilities.statusPanel = false
  assert.equal(b.stop.handles(b.conn, b.action()), false)
})

test('Stop: snapshot openness uses activity and deliverability while other Cards keep their own rule', () => {
  const b = bench()
  const open = b.stop.sourceOpen(b.conn)
  assert.equal(open('t:snapshot:with-colon', b.entries), true)
  b.conn.chats.dm.target = { botId: 'b' }
  assert.equal(open('t:snapshot:with-colon', b.entries), false)
  b.conn.chats.dm.target = { botId: 'a' }
  b.rt.live.clear()
  assert.equal(open('t:snapshot:with-colon', b.entries), false)
  assert.equal(open('q:open', []), true)
  assert.equal(open('q:closed', []), false)
  b.capabilities.statusPanel = false
  b.rt.live.set('a', { turn: 1 })
  assert.equal(open('t:snapshot:with-colon', b.entries), false)
})

test('Stop: showing snapshots owns the session step counter and resets it on turn boundaries', async () => {
  const b = bench()
  b.stop.sessionEvent({ id: 'a' }, { type: 'step/start', data: { step: 4 } })
  await b.stop.show(b.conn, { chat }, { botId: 'a' }, text('ru'))
  const [, key, destinations, body, buttons, structured] = b.sent[0] ?? []
  assert.match(key ?? '', /^t:[0-9a-f-]{36}$/)
  assert.deepEqual(destinations, [{ chat, target: { botId: 'a' } }])
  assert.equal(body, 'Chief — <working:ru>\n<statusTool:ru>: —\n<statusStep:ru>: 4\n<statusElapsed:ru>: 0 s')
  assert.equal(buttons, undefined)
  assert.deepEqual(structured(), { text: body, options: [{ data: `${key}:stop`, label: '<stop:ru>' }] })
  for (const type of ['turn/start', 'turn/end']) {
    b.stop.sessionEvent({ id: 'a' }, { type })
    await b.stop.show(b.conn, { chat }, { botId: 'a' }, text('ru'))
    assert.match(b.sent.at(-1)[3], /<statusStep:ru>: 0\n/)
    b.stop.sessionEvent({ id: 'a' }, { type: 'step/start', data: { step: 8 } })
    b.stop.sessionEvent({ id: 'a' }, { type: 'step/start', data: { step: 1.5 } })
    await b.stop.show(b.conn, { chat }, { botId: 'a' }, text('ru'))
    assert.match(b.sent.at(-1)[3], /<statusStep:ru>: 8\n/)
  }
})

for (const variant of ['idle', 'no rich Cards', 'no connected handle']) {
  test(`Stop: ${variant} snapshot uses captured runner Delivery without a Stop Card`, async () => {
    const b = bench()
    if (variant === 'idle') b.rt.live.clear()
    if (variant === 'no rich Cards') b.capabilities.richCards = false
    if (variant === 'no connected handle') delete b.runner.handle
    await b.stop.show(b.conn, { chat }, { botId: 'a' }, text('ru'))
    assert.deepEqual(b.outputs, [[{ chat, target: { botId: 'a' } }, { text: `Chief — <${variant === 'idle' ? 'statusIdle' : 'working'}:ru>\n<statusTool:ru>: —\n<statusStep:ru>: 0\n<statusElapsed:ru>: 0 s`, rich: true }]])
    assert.deepEqual(b.sent, [])
  })
}
