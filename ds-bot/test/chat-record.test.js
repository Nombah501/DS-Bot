import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { adapters } from '../src/host/im/platforms/index.js'
import { chatRecords } from '../src/host/im/chat-record.js'
import { migrateTopics } from '../src/host/im/topics.js'
import { fakeContext } from './fake-ctx.js'

const sender = { id: 'ann', name: 'Ann', languageCode: 'ru' }
const direct = { key: 'dm', kind: 'direct', title: 'Ann’s chat' }
const message = (chat = direct, text = '/start') => ({ chat, sender, text, mentioned: true })

// The same adapter boundary as im.test.js, with real inbound handlers and an
// in-memory save boundary so an adopt can land at an exact save, without timers.
async function inbound(t, { platform = 'telegram', paired = true, login } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-chat-record-'))
  const conn = {
    id: 'im_record', platform, botId: 'a', settings: {}, secrets: {}, enabled: true,
    nonTelegramTurns: 'all', paired: paired ? [{ ...sender, access: 'all' }] : [], requests: [], chats: {},
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
    im: { connections: { [conn.id]: conn } },
  }))
  const sent = []
  const warnings = []
  const ctx = Object.assign(fakeContext(), { sessions: { flush: async () => {} } })
  const real = adapters[platform]
  const fake = {
    connect(_fields, _env, handlers) {
      fake.handlers = handlers
      return {
        send: async (chat, body) => { sent.push({ chat, ...body }); return { messageId: sent.length } },
        stop() {},
      }
    },
    loginWait: async () => login,
  }
  adapters[platform] = fake
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    try { await ctx.dispose() } finally {
      adapters[platform] = real
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    }
  })
  await rt.load()
  await rt.imEndpoint('im-retry', { id: conn.id })
  t.mock.method(rt, 'warn', (...args) => { warnings.push(args) })
  const saved = []
  t.mock.method(rt, 'save', async () => { saved.push(structuredClone(rt.state.im.connections)) })
  return { rt, fake, sent, saved, warnings, current: () => rt.state.im.connections[conn.id] }
}

test('Chat record: an adopt during arrival preserves sender fields and uses the adopted target', async t => {
  const b = await inbound(t)
  const saved = []
  t.mock.method(b.rt, 'save', async () => {
    await Promise.resolve()
    if (saved.length === 0) {
      // Replace in-memory connections wholesale; disk re-reads discarding unsaved changes belong to Store, outside this ticket.
      b.rt.state.im.connections = structuredClone(b.rt.state.im.connections)
      b.current().botId = 'b'
    }
    saved.push(structuredClone(b.rt.state.im.connections))
  })
  await b.fake.handlers.onMessage(message())
  assert.equal(saved.at(-1).im_record.chats.dm.languageCode, 'ru', 'the adopted chat persists the arriving sender’s language')
  assert.equal(saved.at(-1).im_record.chats.dm.personId, 'ann')
  assert.equal(saved.at(-1).im_record.chats.dm.lastSenderId, 'ann')
  assert.match(b.sent.at(-1).text, /Writer/, 'the handler routes with the adopted connection')
  assert.deepEqual(b.warnings, [])
})

test('Chat record: a first arrival saves creation, forum, person and language once', async t => {
  const b = await inbound(t)
  await b.fake.handlers.onMessage(message({ ...direct, isForum: true }))
  assert.equal(b.saved.length, 1, 'one arrival costs one team-state save, not four')
  assert.deepEqual(b.saved[0].im_record.chats.dm, {
    kind: 'direct', title: 'Ann’s chat', at: b.current().chats.dm.at,
    isForum: true, personId: 'ann', languageCode: 'ru', lastSenderId: 'ann',
  })
  assert.deepEqual(b.warnings, [])
})

test('Chat record: accepting a group pairing request keeps the group’s title', async t => {
  const b = await inbound(t, { paired: false })
  await b.fake.handlers.onMessage(message({ key: 'group', kind: 'group', title: 'Operations' }))
  await b.rt.imEndpoint('im-pair', { id: 'im_record', senderId: 'ann', allow: true })
  assert.equal(b.saved.at(-1).im_record.chats.group.title, 'Operations', 'pairing keeps the group title, not the requesting person’s name')
  assert.equal(b.current().chats.group.personId, undefined)
  assert.deepEqual(b.warnings, [])
})

const bench = ({ capabilities = { topics: true, personLanguage: true }, chats = {}, onSave } = {}) => {
  const conn = { id: 'one', platform: 'test', paired: [sender], chats }
  const state = { im: { connections: { one: conn } } }
  const saved = []
  const rt = {
    state,
    save: async () => {
      await onSave?.(state)
      saved.push(structuredClone(state.im.connections.one))
    },
  }
  const records = chatRecords(rt, { connections: () => state.im.connections, platformOf: () => capabilities })
  return { state, saved, records, current: () => state.im.connections.one }
}

test('Chat record: arrivals preserve saved metadata and sticky forum state, and unchanged arrivals do not save', async () => {
  const chat = { kind: 'direct', title: 'Saved title', at: 12, target: { botId: 'a' }, topics: { 7: { target: { botId: 'b' } } }, bindCards: { 1: { id: 'held' } } }
  const b = bench({ chats: { dm: chat } })
  await b.records.arrived('one', message({ ...direct, isForum: true }))
  assert.deepEqual(b.saved[0].chats.dm, {
    kind: 'direct', title: 'Saved title', at: 12, target: { botId: 'a' },
    topics: { 7: { target: { botId: 'b' } } }, bindCards: { 1: { id: 'held' } },
    isForum: true, personId: 'ann', languageCode: 'ru', lastSenderId: 'ann',
  })
  await b.records.arrived('one', message({ ...direct, isForum: false }))
  assert.equal(b.current().chats.dm.isForum, true)
  assert.equal(b.saved.length, 1)
})

test('Chat record: arrival returns the adopted records after its save', async () => {
  const b = bench({ onSave: state => {
    state.im.connections = structuredClone(state.im.connections)
    state.im.connections.one.chats.dm.target = { botId: 'b' }
  } })
  const result = await b.records.arrived('one', message())
  assert.deepEqual(result.chat.target, { botId: 'b' })
  assert.equal(result.conn.chats.dm, result.chat)
  assert.equal(result.conn, b.current())
  assert.equal(b.saved[0].chats.dm.personId, 'ann')
  assert.equal(b.saved.length, 1)
})

test('Chat record: presses update only existing chats and save language or speaker changes once', async () => {
  const b = bench({ chats: { group: { kind: 'group', title: 'Ops', at: 1 } } })
  await b.records.heard('one', 'missing', sender)
  assert.equal(b.current().chats.missing, undefined)
  assert.equal(b.saved.length, 0)
  await b.records.heard('one', 'group', sender)
  assert.deepEqual(b.saved[0].chats.group, { kind: 'group', title: 'Ops', at: 1, languageCode: 'ru', lastSenderId: 'ann' })
  await b.records.heard('one', 'group', sender)
  assert.equal(b.saved.length, 1)
  await b.records.heard('one', 'group', { id: 'bob', languageCode: 'ru' })
  assert.equal(b.saved[1].chats.group.lastSenderId, 'bob')
  await b.records.heard('one', 'group', { id: 'bob' })
  assert.equal(b.saved[2].chats.group.languageCode, undefined)
  assert.equal(b.saved.length, 3)
})

test('Chat record: person ownership does not need capabilities, but language and forum state do', async () => {
  const b = bench({ capabilities: {} })
  await b.records.paired('one', { ...sender, chatKey: 'paired', chatKind: 'direct', chatTitle: 'Pair chat' })
  assert.deepEqual(b.saved[0].chats.paired, { kind: 'direct', title: 'Pair chat', at: b.current().chats.paired.at, personId: 'ann' })
  await b.records.arrived('one', message({ ...direct, isForum: true }))
  assert.deepEqual(b.saved[1].chats.dm, { kind: 'direct', title: 'Ann’s chat', at: b.current().chats.dm.at, personId: 'ann' })
  await b.records.heard('one', 'dm', { id: 'bob', languageCode: 'en' })
  assert.equal(b.saved.length, 2)
  assert.equal(b.current().chats.dm.languageCode, undefined)
  assert.equal(b.current().chats.dm.lastSenderId, undefined)
  await b.records.arrived('one', message({ key: 'group', kind: 'group', title: 'Ops' }))
  assert.equal(b.current().chats.group.personId, undefined)
})

test('Chat record: only a Paired person can become a direct chat’s owner, including a different sender', async () => {
  const b = bench()
  await b.records.arrived('one', { ...message(), sender: { id: 'unknown' } })
  assert.equal(b.current().chats.dm.personId, undefined)
  await b.records.arrived('one', message())
  assert.equal(b.saved.at(-1).chats.dm.personId, 'ann')
  b.current().paired.push({ id: 'bob' })
  await b.records.arrived('one', { ...message(), sender: { id: 'bob' } })
  assert.equal(b.saved.at(-1).chats.dm.personId, 'bob')
})

test('Chat record: old pairing requests fall back to the person’s name and existing chat metadata survives acceptance', async () => {
  const b = bench()
  const request = { ...sender, chatKey: 'group', chatKind: 'group' }
  await b.records.paired('one', request)
  assert.deepEqual(b.saved[0].chats.group, { kind: 'group', title: 'Ann', at: b.current().chats.group.at, languageCode: 'ru' })
  await b.records.heard('one', 'group', { id: 'bob', languageCode: 'en' })
  await b.records.paired('one', { ...request, chatTitle: 'New title' })
  assert.equal(b.saved.at(-1).chats.group.title, 'Ann')
  assert.equal(b.saved.at(-1).chats.group.at, b.saved[0].chats.group.at)
  assert.equal(b.saved.at(-1).chats.group.lastSenderId, 'bob')
  assert.equal(b.saved.at(-1).chats.group.languageCode, 'ru')
  await b.records.paired('one', request)
  assert.equal(b.saved.length, 4, 'acceptance saves its connection pairing changes even when chat fields match')
})

test('Chat record: targets and removal resolve adopted chats and do not save unchanged records', async () => {
  const b = bench({ chats: { dm: { kind: 'direct', title: 'Old', at: 1 } } })
  const detached = b.current()
  b.state.im.connections = structuredClone(b.state.im.connections)
  b.current().chats.dm.title = 'Adopted'
  await b.records.setTarget('one', 'dm', { botId: 'a' })
  assert.deepEqual(b.saved[0].chats.dm, { kind: 'direct', title: 'Adopted', at: 1, target: { botId: 'a' } })
  assert.equal(detached.chats.dm.target, undefined)
  await b.records.setTarget('one', 'dm', { botId: 'a' })
  assert.equal(b.saved.length, 1)
  await b.records.setTarget('one', 'dm', { roomId: 'ops' })
  assert.deepEqual(b.saved[1].chats.dm.target, { roomId: 'ops' })
  await b.records.setTarget('one', 'dm', undefined)
  assert.equal(Object.hasOwn(b.saved[2].chats.dm, 'target'), false)
  await b.records.setTarget('one', 'dm', undefined)
  assert.equal(b.saved.length, 3)
  await b.records.remove('one', 'dm')
  assert.deepEqual(b.saved[3].chats, {})
  assert.ok(detached.chats.dm)
  await b.records.remove('one', 'dm')
  assert.equal(b.saved.length, 4)
})

test('Chat record: Topic migration backfills only missing direct-chat owners without changing saved owners', () => {
  const conn = {
    paired: [{ id: 'ann' }], chats: {
      ann: { kind: 'direct' }, unknown: { kind: 'direct' }, group: { kind: 'group' },
      existing: { kind: 'direct', personId: 'saved' },
    },
  }
  assert.equal(migrateTopics(conn), true)
  assert.equal(conn.chats.ann.personId, 'ann')
  assert.equal(conn.chats.unknown.personId, undefined)
  assert.equal(conn.chats.group.personId, undefined)
  assert.equal(conn.chats.existing.personId, 'saved')
  assert.equal(migrateTopics(conn), false)
})

test('Chat record: a /bind message records the direct sender’s ownership and language in one arrival save', async t => {
  const b = await inbound(t)
  await b.fake.handlers.onMessage(message(direct, '/bind'))
  assert.equal(b.saved[0].im_record.chats.dm.personId, 'ann')
  assert.equal(b.saved[0].im_record.chats.dm.languageCode, 'ru')
  assert.equal(b.saved[0].im_record.chats.dm.lastSenderId, 'ann')
  assert.equal(b.saved.length, 1)
  assert.ok(b.sent.length > 0)
  assert.deepEqual(b.warnings, [])
})

test('Chat record: non-Topics pairing and first arrival store ownership without changing language or routing', async t => {
  const b = await inbound(t, { platform: 'dingtalk', paired: false })
  await b.fake.handlers.onMessage(message())
  await b.rt.imEndpoint('im-pair', { id: 'im_record', senderId: 'ann', allow: true })
  assert.equal(b.saved.at(-1).im_record.chats.dm.personId, 'ann')
  assert.equal(b.saved.at(-1).im_record.chats.dm.languageCode, undefined)
  assert.match(b.sent.at(-1).text, /Chief/)
  await b.fake.handlers.onMessage(message({ key: 'second', kind: 'direct', title: 'Second chat' }))
  assert.equal(b.saved.at(-1).im_record.chats.second.personId, 'ann')
  assert.equal(b.saved.at(-1).im_record.chats.second.languageCode, undefined)
  assert.equal(b.saved.at(-1).im_record.chats.second.lastSenderId, undefined)
  assert.match(b.sent.at(-1).text, /Chief/)
  assert.deepEqual(b.warnings, [])
})

test('Chat record: QR login creates the owner’s direct chat through pairing with one save', async t => {
  const b = await inbound(t, { platform: 'weixin', login: {
    status: 'done', connection: { account: { id: 'wx', name: 'Weixin' } }, owner: { id: 'owner', name: 'Owner' },
  } })
  const result = await b.rt.imEndpoint('im-login-wait', { platform: 'weixin', botId: 'a', loginId: 'login' })
  assert.equal(result.status, 'done')
  assert.deepEqual(b.saved[0][result.id].chats.owner, {
    kind: 'direct', title: 'Owner', at: b.saved[0][result.id].chats.owner.at, personId: 'owner',
  })
  assert.equal(b.saved.length, 1)
  assert.deepEqual(b.warnings, [])
})

test('Chat record: im-chat preserves target validation and saves only changed bindings or removal', async t => {
  const b = await inbound(t)
  await b.fake.handlers.onMessage(message())
  b.saved.length = 0
  const body = { id: 'im_record', chatKey: 'dm' }
  await assert.rejects(b.rt.imEndpoint('im-chat', { ...body, target: { botId: 'missing' } }), /Choose a Bot or a group/)
  assert.equal(b.saved.length, 0)
  assert.equal(await b.rt.imEndpoint('im-chat', { ...body, target: { botId: 'b' } }), true)
  assert.deepEqual(b.saved[0].im_record.chats.dm.target, { botId: 'b' })
  await b.fake.handlers.onMessage(message())
  assert.match(b.sent.at(-1).text, /Writer/)
  await b.rt.imEndpoint('im-chat', { ...body, target: { botId: 'b' } })
  await b.rt.imEndpoint('im-chat', body)
  assert.equal(b.saved.length, 1)
  await b.rt.imEndpoint('im-chat', { ...body, target: null })
  assert.equal(Object.hasOwn(b.saved[1].im_record.chats.dm, 'target'), false)
  await b.rt.imEndpoint('im-chat', { ...body, remove: true })
  assert.deepEqual(b.saved[2].im_record.chats, {})
  await assert.rejects(b.rt.imEndpoint('im-chat', { ...body, target: null }), /No such chat/)
  assert.equal(b.saved.length, 3)
  assert.deepEqual(b.warnings, [])
})

for (const removed of ['chat', 'connection']) {
  test(`Chat record: an arrival quietly stops when its ${removed} is removed during its save`, async t => {
    const b = await inbound(t)
    const saving = Promise.withResolvers()
    const resume = Promise.withResolvers()
    t.after(() => resume.resolve())
    let saves = 0
    t.mock.method(b.rt, 'save', async () => {
      if (++saves !== 1) return
      saving.resolve()
      await resume.promise
    })
    // Surface the handler's rejection rather than swallowing it as a warning.
    t.mock.method(b.rt, 'warn', (_template, error) => { throw error })
    const arrival = b.fake.handlers.onMessage(message())
    await saving.promise
    if (removed === 'chat') await b.rt.imEndpoint('im-chat', { id: 'im_record', chatKey: 'dm', remove: true })
    else await b.rt.imEndpoint('im-remove', { id: 'im_record' })
    resume.resolve()
    await assert.doesNotReject(arrival, `removing the ${removed} must quietly stop the arrival`)
    assert.equal(b.current()?.chats.dm, undefined)
    if (removed === 'connection') assert.equal(b.current(), undefined)
    assert.deepEqual(b.sent, [])
  })
}
