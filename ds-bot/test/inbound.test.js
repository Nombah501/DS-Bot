import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inbound } from '../src/host/im/inbound.js'
import { chatRecords } from '../src/host/im/chat-record.js'
import { showStatus } from '../src/host/im/status-panel.js'

const sender = { id: 'ann', name: 'Ann', languageCode: 'en' }
const direct = { key: 'dm', kind: 'direct', title: 'Ann’s chat' }
const forum = { key: 'forum', kind: 'group', title: 'Operations', isForum: true, threadId: 7 }
const text = (key, values) => `<${key}${values === undefined ? '' : `:${JSON.stringify(values)}`}>`
const bench = ({ capabilities = { topics: true, personLanguage: true }, onSave, uploadFile, onAsked, number = async () => false } = {}) => {
  let conn = {
    id: 'one', platform: 'test', botId: 'a', paired: [{ ...sender, access: true }], requests: [],
    chats: { forum: { kind: 'group', isForum: true, topics: { 7: { target: { botId: 'a' } } } } },
  }
  const saved = []
  const notices = []
  const outputs = []
  const sent = []
  const uploads = []
  const origins = new Map()
  const numbers = []
  const binds = []
  const stops = []
  const rt = {
    save: async () => { await onSave?.(b); saved.push(structuredClone(conn)) },
    sendUser: async request => { sent.push(request) },
    botOf: id => ['a', 'b'].includes(id) ? { name: id === 'a' ? 'Chief' : 'Writer' } : undefined,
    chatOf: id => `chat-${id}`,
    roomOf: id => id === 'room' ? { name: 'Operations' } : undefined,
    state: {}, live: new Map(), approvalsView: () => [],
  }
  const connections = () => ({ one: conn })
  const place = {
    targetOf: (current, chat) => chat.threadId === undefined
      ? current.chats[chat.key]?.target ?? (chat.kind === 'direct' && current.botId ? { botId: current.botId } : undefined)
      : current.chats[chat.key]?.topics?.[chat.threadId]?.target,
    may: (current, id) => capabilities.topics !== true || current.paired.some(person => person.id === id && person.access),
    asked: async (_conn, id, person, chat) => { origins.set(id, { person, chat }); await onAsked?.(b) },
    unasked: async (_conn, id) => { origins.delete(id) },
  }
  const handler = inbound(rt, {
    records: chatRecords(rt, { connections, platformOf: () => capabilities }), place, connections,
    kinds: { number: async (...args) => { numbers.push(args); return number(...args) } },
    forumBind: { command: async (...args) => { binds.push(args) } },
    deliveryOf: () => ({
      notice: (chat, body) => { notices.push({ chat, ...body }) },
      output: (place, body) => { outputs.push({ place, ...body }) },
    }),
    showStatus: (_conn, msg, target, text) => showStatus(rt, {
      chat: msg.chat, target, text, richCards: false,
      sendText: body => { outputs.push({ place: { chat: msg.chat, target }, text: body }) },
    }),
    textForPerson: () => text,
    targetName: (_conn, target) => rt.botOf(target.botId)?.name ?? rt.roomOf(target.roomId)?.name,
    stopTarget: async (...args) => { stops.push(args) },
    envFor: async () => ({ uploadFile: async (...args) => { uploads.push(args); await uploadFile?.(b); return 'receipt' } }),
    platformOf: () => capabilities,
  })
  const b = {
    rt, saved, notices, outputs, sent, uploads, origins, numbers, binds, stops,
    current: () => conn,
    adopt: change => { conn = structuredClone(conn); change(conn) },
    message: (body = 'hello', extra = {}) => handler.message(conn, { chat: direct, sender, text: body, ...extra }),
  }
  return b
}

test('Inbound: /status without Topics sends a Status snapshot, not a Bot message', async () => {
  const b = bench({ capabilities: {} })
  await b.message('/status')
  assert.equal(b.sent.length, 0, '/status must not reach the Bot on a non-Topics platform')
  assert.match(b.outputs[0].text, /Chief — <statusIdle>/)
  assert.equal(b.outputs[0].buttons, undefined)
})

for (const change of ['Access narrowed', 'target rebound']) {
  test(`Inbound: ${change} during a file upload refuses delivery to the old Bot`, async () => {
    const b = bench({ uploadFile: b => b.adopt(conn => {
      if (change === 'Access narrowed') conn.paired[0].access = false
      else conn.chats.forum.topics[7].target = { botId: 'b' }
    }) })
    await b.message('document', { chat: forum, files: [{ name: 'report.txt', data: 'report' }] })
    assert.equal(b.sent.length, 0, `${change} during upload must not deliver to the old Bot`)
    assert.equal(b.notices.at(-1).text, '<denied>')
    assert.equal(b.uploads.length, 1)
    assert.equal(b.origins.size, 0)
  })
}

test('Inbound: /lang from a person unpaired during arrival save is quietly ignored', async () => {
  const b = bench({ onSave: b => b.adopt(conn => { conn.paired = [] }) })
  await assert.doesNotReject(b.message('/lang ru'), '/lang after an arrival-time unpair must not throw')
  assert.deepEqual(b.notices, [])
  assert.deepEqual(b.sent, [])
  assert.deepEqual(b.current().paired, [])
})

for (const suffix of ['', '@fakebot']) {
  for (const command of ['bind', 'lang', 'start', 'stop', 'status']) {
    test(`Inbound: /${command}${suffix} is recognised by the command table`, async () => {
      const b = bench()
      await b.message(`  /${command}${suffix}${command === 'lang' ? ' ru' : ''}  `)
      assert.deepEqual(b.sent, [])
      if (command === 'bind') assert.equal(b.binds.length, 1)
      if (command === 'lang') {
        assert.equal(b.saved.at(-1).paired[0].language, 'ru')
        assert.equal(b.notices.at(-1).text, '<language:{"language":"ru"}>')
      }
      if (command === 'start') assert.equal(b.notices.at(-1).text, '<greeting:{"name":"Chief"}>')
      if (command === 'stop') assert.equal(b.stops[0][2].botId, 'a')
      if (command === 'status') assert.match(b.outputs[0].text, /Chief — <statusIdle>/)
    })
  }
}

test('Inbound: non-commands and commands with unsupported arguments still reach the Bot', async () => {
  const b = bench()
  for (const body of ['hello', '/status extra', '/stop@fakebot extra', '/unknown', '/starter', '/langish ru', '/start@']) {
    await b.message(body)
    assert.deepEqual(b.sent.at(-1).content, [{ type: 'text', text: body }])
  }
  assert.equal(b.sent.length, 7)
  assert.deepEqual(b.notices, [])
})

test('Inbound: /lang accepts only the existing language arguments and runs before Access', async () => {
  const b = bench()
  b.current().paired[0].access = false
  for (const body of ['/lang', '/lang xx', '/lang ru extra']) {
    await b.message(body)
    assert.equal(b.current().paired[0].language, undefined)
    assert.equal(b.notices.at(-1).text, '<language:{"language":"auto"}>')
  }
  await b.message('/lang en')
  assert.equal(b.saved.at(-1).paired[0].language, 'en')
  await b.message('/lang auto')
  assert.equal(b.saved.at(-1).paired[0].language, 'auto')
  assert.deepEqual(b.sent, [])
})

test('Inbound: capability-gated /bind and /lang remain ordinary text elsewhere', async () => {
  const b = bench({ capabilities: {} })
  for (const body of ['/bind@fakebot', '/lang@fakebot ru']) {
    await b.message(body)
    assert.deepEqual(b.sent.at(-1).content, [{ type: 'text', text: body }])
  }
  assert.equal(b.sent.length, 2)
  assert.deepEqual(b.binds, [])
  assert.equal(b.current().paired[0].language, undefined)
})

test('Inbound: pairing requests dedupe across chats and retain the request fields', async () => {
  const b = bench()
  b.current().paired = []
  await b.message('hello', { chat: forum, mentioned: false })
  assert.deepEqual(b.current().requests, [])
  assert.deepEqual(b.notices, [])
  await b.message('hello')
  const request = b.saved[0].requests[0]
  assert.deepEqual(request, {
    id: 'ann', name: 'Ann', chatKey: 'dm', chatKind: 'direct',
    chatTitle: 'Ann’s chat', languageCode: 'en', at: request.at,
  })
  assert.equal(b.notices.at(-1).text, '<requested>')
  await b.message('hello', { chat: forum, mentioned: true })
  assert.equal(b.saved.length, 1)
  assert.equal(b.notices.length, 1)
  assert.equal(b.current().chats.dm, undefined)
  assert.deepEqual(b.sent, [])
})

test('Inbound: non-language platforms omit language from pairing requests', async () => {
  const b = bench({ capabilities: {} })
  b.current().paired = []
  await b.message('hello')
  assert.equal(Object.hasOwn(b.saved[0].requests[0], 'languageCode'), false)
  assert.equal(b.notices.at(-1).text, '<requested>')
})

test('Inbound: ordinary groups require a mention while Topics forums do not', async () => {
  const b = bench()
  const group = { key: 'group', kind: 'group', title: 'Ordinary' }
  await b.message('hello', { chat: group })
  assert.deepEqual(b.sent, [])
  assert.equal(b.current().chats.group, undefined)
  await b.message('hello', { chat: forum })
  assert.equal(b.sent.length, 1)
  b.current().chats.group = { kind: 'group', target: { roomId: 'room' } }
  await b.message('hello', { chat: group, mentioned: true })
  assert.equal(b.sent.at(-1).sessionId, 'room')
  const other = bench({ capabilities: {} })
  await other.message('hello', { chat: forum })
  assert.deepEqual(other.sent, [])
})

test('Inbound: /bind runs before Access but ordinary commands are denied first', async () => {
  const b = bench()
  b.current().paired[0].access = false
  await b.message('/bind', { chat: forum })
  assert.equal(b.binds.length, 1)
  assert.deepEqual(b.notices, [])
  for (const body of ['/start', '/stop', '/status', 'hello']) {
    await b.message(body)
    assert.equal(b.notices.at(-1).text, '<denied>')
  }
  assert.deepEqual(b.stops, [])
  assert.deepEqual(b.outputs, [])
  assert.deepEqual(b.sent, [])
})

test('Inbound: numbers may answer a Card before the later Access denial', async () => {
  const consumed = bench({ number: async () => true })
  consumed.current().paired[0].access = false
  await consumed.message('1 3')
  assert.equal(consumed.numbers.length, 1)
  assert.deepEqual(consumed.notices, [])
  assert.deepEqual(consumed.sent, [])
  const refused = bench()
  refused.current().paired[0].access = false
  await refused.message('1')
  assert.equal(refused.numbers.length, 1)
  assert.equal(refused.notices.at(-1).text, '<denied>')
  assert.deepEqual(refused.sent, [])
  const ordinary = bench()
  await ordinary.message('99')
  assert.deepEqual(ordinary.sent[0].content, [{ type: 'text', text: '99' }])
})

for (const [chat, hint] of [[direct, 'unbound'], [{ key: 'group', kind: 'group' }, 'unboundGroup'], [forum, 'bindHint']]) {
  test(`Inbound: an unbound ${chat.key} answers commands and text with ${hint}`, async () => {
    const b = bench()
    delete b.current().botId
    delete b.current().chats.forum.topics[7]
    for (const body of ['/start', '/stop', '/status', 'hello']) {
      await b.message(body, { chat, mentioned: true })
      assert.equal(b.notices.at(-1).text, `<${hint}>`)
    }
    assert.deepEqual(b.sent, [])
    assert.deepEqual(b.stops, [])
    assert.deepEqual(b.outputs, [])
  })
}

test('Inbound: text, images and uploaded files retain their content and Bot upload session', async () => {
  const b = bench()
  await b.message(' hello ', {
    images: [{ mediaType: 'image/png', data: 'base64' }],
    files: [{ name: 'report.txt', data: 'report' }],
  })
  assert.deepEqual(b.sent[0].content, [
    { type: 'text', text: 'hello' }, { type: 'image', mediaType: 'image/png', data: 'base64' },
    { type: 'file', receiptId: 'receipt' },
  ])
  assert.equal(b.sent[0].sessionId, 'a')
  assert.match(b.sent[0].requestId, /^im:test:/)
  assert.equal(b.uploads[0][0], 'chat-a')
  assert.equal(b.origins.get(b.sent[0].requestId).person.id, 'ann')
})

test('Inbound: failed file uploads notify the person and still send remaining text', async () => {
  const b = bench({ uploadFile: () => { throw new Error('upload failed') } })
  await b.message('hello', { files: [{ name: 'report.txt' }] })
  assert.equal(b.notices.at(-1).text, '<noFile>')
  assert.deepEqual(b.sent[0].content, [{ type: 'text', text: 'hello' }])
  await b.message('', { files: [{ name: 'empty.txt' }] })
  assert.equal(b.notices.at(-1).text, '<noFile>')
  assert.equal(b.sent.length, 1)
  assert.equal(b.origins.size, 1)
})

test('Inbound: empty messages do not start a Bot turn or record an Origin', async () => {
  const b = bench()
  await b.message('   ')
  assert.deepEqual(b.sent, [])
  assert.equal(b.origins.size, 0)
})

test('Inbound: send failures remove the Origin and retain the original rejection', async () => {
  const b = bench()
  const error = new Error('send failed')
  b.rt.sendUser = async () => { throw error }
  await assert.rejects(b.message(), error)
  assert.equal(b.origins.size, 0)
})

for (const change of ['Access narrowed', 'target rebound', 'target unbound', 'person unpaired']) {
  test(`Inbound: ${change} during the Origin save refuses delivery`, async () => {
    const b = bench({ onAsked: b => b.adopt(conn => {
      if (change === 'Access narrowed') conn.paired[0].access = false
      if (change === 'target rebound') conn.chats.forum.topics[7].target = { botId: 'b' }
      if (change === 'target unbound') delete conn.chats.forum.topics[7]
      if (change === 'person unpaired') conn.paired = []
    }) })
    await b.message('hello', { chat: forum })
    assert.deepEqual(b.sent, [])
    assert.equal(b.notices.at(-1).text, change === 'target unbound' ? '<bindHint>' : '<denied>')
    assert.equal(b.origins.size, 0)
  })
}
