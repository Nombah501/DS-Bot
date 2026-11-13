import assert from 'node:assert/strict'
import { test } from 'node:test'
import { delivery } from '../src/host/im/delivery.js'
import { cardJournal } from '../src/host/im/cards.js'
import { setup, telegram } from './placement-fixture.js'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('a failed receipt is reported once without resending or overtaking the next Step message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const conn = telegram()
  const { place, byId } = setup([conn])
  const writes = []
  const warnings = []
  const receiptStarted = deferred()
  const receiptReady = deferred()
  const statuses = []
  const queue = delivery({
    connection: () => byId[conn.id], placement: place,
    warn: (...args) => warnings.push(args), setStatus: status => statuses.push(status),
  })
  queue.attach({ send: async (chat, content) => {
    writes.push({ chat: { ...chat }, text: content.text })
    return { messageId: writes.length }
  } })
  const destination = place.places(conn, { botId: 'a' }, 's', 'message')[0]
  const first = queue.output(destination, { text: 'First Step' }, { sent: async () => {
    receiptStarted.resolve()
    await receiptReady.promise
    throw new Error('journal write failed')
  } })
  await receiptStarted.promise
  const second = queue.output(destination, { text: 'Second Step' })
  assert.deepEqual(writes.map(item => item.text), ['First Step'])
  receiptReady.resolve()
  await Promise.all([first, second])
  assert.deepEqual(writes.map(item => item.text), ['First Step', 'Second Step'])
  t.mock.timers.tick(10_000)
  assert.deepEqual(writes.map(item => item.text), ['First Step', 'Second Step'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].join(' '), /journal write failed/)
  assert.deepEqual(statuses, [])
  await queue.close()
})

const forum = { key: '-60', kind: 'group', threadId: 40 }
const direct = { key: '5', kind: 'direct', threadId: 101 }
const ann = { id: '9', languageCode: 'en' }
// Let the rejected adapter attempt reach its retry policy before advancing time.
const nextTurn = () => new Promise(setImmediate)
const bench = ({ conn = telegram(), send, sending, recoverTopic, attach = true } = {}) => {
  const env = setup([conn])
  const calls = []
  const statuses = []
  const warnings = []
  const handle = {
    send: async (chat, content) => {
      calls.push({ chat: { ...chat }, ...content })
      return send === undefined ? { messageId: calls.length } : send(chat, content, calls.length)
    },
    sendCard: (chat, card) => handle.send(chat, { card }),
    sendPrivateCard: (chat, receiverUserId, card) => handle.send(chat, { receiverUserId, card }),
    editCard: async () => {},
    editPrivateCard: async () => {},
    deletePrivateCard: async () => {},
  }
  const queue = delivery({
    connection: () => env.byId[conn.id], placement: env.place, sending, recoverTopic,
    setStatus: status => statuses.push(status), warn: (...args) => warnings.push(args),
  })
  if (attach) queue.attach(handle)
  return { ...env, conn, queue, handle, calls, statuses, warnings }
}
const origin = async (b, chat = forum, turn = 1) => {
  const requestId = `request-${turn}`
  await b.place.asked(b.conn, requestId, ann, chat)
  b.place.sessionEvent({ id: 's' }, { type: 'turn/start', data: { turn } })
  b.place.sessionEvent({ id: 's' }, { type: 'user/message', data: { source: { rpcId: requestId } } })
}

test('network retries keep the first Step ahead of the second with one retryAfter timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const b = bench({ send: async (_chat, content, attempt) => {
    if (content.text === 'First' && attempt < 3) throw Object.assign(new Error('network down'), { retryAfter: 2 })
    return { messageId: attempt }
  } })
  const destination = b.place.places(b.conn, { botId: 'a' }, 's', 'message')[0]
  const first = b.queue.output(destination, { text: 'First' })
  await nextTurn()
  const second = b.queue.output(destination, { text: 'Second' })
  t.mock.timers.tick(1999)
  assert.deepEqual(b.calls.map(call => call.text), ['First'])
  t.mock.timers.tick(1)
  await nextTurn()
  assert.deepEqual(b.calls.map(call => call.text), ['First', 'First'])
  t.mock.timers.tick(2000)
  await Promise.all([first, second])
  assert.deepEqual(b.calls.map(call => call.text), ['First', 'First', 'First', 'Second'])
  t.mock.timers.tick(20_000)
  assert.equal(b.calls.length, 4)
  await b.queue.close()
})

for (const address of [forum, direct]) test(`queued Step retains its ${address.kind} Origin after a new turn and connection replacement`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const b = bench({ send: async (_chat, _content, attempt) => {
    if (attempt === 1) throw new Error('network down')
    return { messageId: attempt }
  } })
  await origin(b, address)
  const destination = b.place.places(b.conn, { botId: 'a' }, 's', 'message')[0]
  const sent = b.queue.output(destination, { text: 'Original turn' })
  await nextTurn()
  b.place.sessionEvent({ id: 's' }, { type: 'turn/end' })
  await origin(b, address === forum ? direct : forum, 2)
  b.byId[b.conn.id] = structuredClone(b.conn)
  b.byId[b.conn.id].nonTelegramTurns = 'cards'
  t.mock.timers.tick(5000)
  await sent
  assert.deepEqual(b.calls.map(call => [call.chat.key, call.chat.threadId]), [
    [address.key, address.threadId], [address.key, address.threadId],
  ])
  await b.queue.close()
})

for (const revoke of ['unbind', 'Access']) test(`${revoke} revocation prevents retry of a queued Step`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const b = bench({ send: async () => { throw new Error('network down') } })
  const address = revoke === 'unbind' ? forum : direct
  await origin(b, address)
  const sent = b.queue.output(b.place.places(b.conn, { botId: 'a' }, 's', 'message')[0], { text: 'Revoked Step' })
  await nextTurn()
  const current = b.byId[b.conn.id] = structuredClone(b.conn)
  if (revoke === 'unbind') delete current.chats[forum.key].topics[40].target
  else current.paired[0].access = { botIds: [], roomIds: [] }
  t.mock.timers.tick(5000)
  await sent
  assert.equal(b.calls.length, 1, 'only the refused attempt')
  await b.queue.close()
})

test('reserve queues before attach, bound status needs no turn output, and Bridge notices include control Cards', async () => {
  const b = bench({ attach: false })
  const status = b.queue.output({ chat: forum, target: { botId: 'a' } }, { text: 'Status snapshot', rich: true })
  assert.deepEqual(b.calls, [])
  b.queue.attach(b.handle)
  await status
  const unbound = { key: '-70', kind: 'group', threadId: 80 }
  await b.queue.notice(unbound, { text: 'Choose a Bot' })
  await b.queue.notice(unbound, { card: { text: 'Bind', options: [{ label: 'Chief' }] } })
  assert.deepEqual(b.calls.map(call => call.text ?? call.card.text), ['Status snapshot', 'Choose a Bot', 'Bind'])
  assert.deepEqual(b.calls.slice(1).map(call => call.chat), [unbound, unbound])
  for (const malformed of [forum, { chat: forum }, { chat: forum, target: {} }, { chat: forum, target: null }]) {
    assert.throws(() => b.queue.output(malformed, { text: 'Unsafe' }), /Placement place/)
  }
  assert.equal(b.calls.length, 3)
  await b.queue.close()
})

test('non-Topics current-Bot output keeps platform capability gates', async () => {
  const conn = { id: 'other', platform: 'dingtalk', botId: 'a', chats: { dm: { kind: 'direct' } } }
  const b = bench({ conn })
  const destination = b.place.places(conn, { botId: 'a' }, 's', 'message')[0]
  await b.queue.output(destination, { text: 'Current Bot', rich: true })
  await b.queue.output(destination, { text: 'Card fallback', card: { text: 'Card' } })
  assert.deepEqual(b.calls.map(call => call.text), ['Current Bot', 'Card fallback'])
  assert.equal(b.calls[0].rich, undefined)
  await b.queue.close()
})

test('FIFO is per physical address including Topic, not per chat', async () => {
  const gate = deferred()
  const b = bench({ send: async (_chat, content) => {
    if (content.text === 'Held') await gate.promise
    return { messageId: 1 }
  } })
  const held = b.queue.notice({ ...forum, threadId: 41 }, { text: 'Held' })
  const behind = b.queue.notice({ ...forum, threadId: 41 }, { text: 'Behind' })
  await b.queue.notice(forum, { text: 'Other Topic' })
  assert.deepEqual(b.calls.map(call => call.text), ['Held', 'Other Topic'])
  gate.resolve()
  await Promise.all([held, behind])
  assert.deepEqual(b.calls.map(call => call.text), ['Held', 'Other Topic', 'Behind'])
  await b.queue.close()
})

for (const kind of ['permanent', 'unknown', 'stopped']) test(`${kind} send failures drop without retry and the next Step proceeds`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const b = bench({ send: async (_chat, _content, attempt) => {
    if (attempt === 1) throw Object.assign(new Error('wire refused'), { [kind]: true })
    return { messageId: attempt }
  } })
  const destination = { chat: forum, target: { botId: 'a' } }
  await Promise.all([b.queue.output(destination, { text: 'Refused' }), b.queue.output(destination, { text: 'Next' })])
  t.mock.timers.tick(10_000)
  assert.deepEqual(b.calls.map(call => call.text), ['Refused', 'Next'])
  assert.deepEqual(b.statuses, kind === 'permanent' ? [{ state: 'error', error: 'wire refused' }] : [])
  await b.queue.close()
})

test('final output waits for its Draft, then rechecks its binding and Private expiry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const draft = deferred()
  const b = bench({ sending: () => draft.promise })
  const privateCard = b.queue.output({ chat: forum, target: { botId: 'a' } }, {
    card: { text: 'Private', options: [] }, receiverUserId: '9', privateUntil: Date.now() + 1000,
  })
  assert.deepEqual(b.calls, [])
  t.mock.timers.tick(1000)
  draft.resolve()
  await privateCard
  assert.deepEqual(b.calls, [])
  await b.queue.notice(forum, { text: 'After Draft' })
  assert.deepEqual(b.calls.map(call => call.text), ['After Draft'])
  await b.queue.close()
})

test('a bound status waiting for its Draft is dropped if the Topic is rebound', async () => {
  const draft = deferred()
  const b = bench({ sending: () => draft.promise })
  const status = b.queue.output({ chat: forum, target: { botId: 'a' } }, { text: 'Old status' })
  b.byId[b.conn.id] = structuredClone(b.conn)
  b.byId[b.conn.id].chats[forum.key].topics[40].target = { botId: 'b' }
  draft.resolve()
  await status
  assert.deepEqual(b.calls, [])
  await b.queue.close()
})

for (const stage of ['retry', 'Draft', 'recovery']) test(`close discards work during ${stage} without waiting or reviving the old handle`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred()
  const started = deferred()
  const b = bench({
    sending: stage === 'Draft' ? () => { started.resolve(); return gate.promise } : undefined,
    send: async () => {
      started.resolve()
      throw Object.assign(new Error('not sent'), stage === 'recovery' ? { topicMissing: true } : {})
    },
    recoverTopic: async () => { started.resolve(); await gate.promise; return true },
  })
  const first = b.queue.output({ chat: direct, target: { botId: 'a' } }, { text: 'Held' })
  await started.promise
  await nextTurn()
  const second = b.queue.output({ chat: direct, target: { botId: 'a' } }, { text: 'Discarded' })
  await b.queue.close()
  await Promise.all([first, second])
  const attempts = b.calls.length
  await b.queue.notice(direct, { text: 'After close' })
  b.queue.attach(b.handle)
  gate.resolve()
  await nextTurn()
  t.mock.timers.tick(20_000)
  await nextTurn()
  assert.equal(b.calls.length, attempts)
  assert.equal(attempts, stage === 'Draft' ? 0 : 1)
})

for (const phase of ['wire', 'receipt', 'failed wire']) test(`close waits for an in-flight ${phase}, discards followers and never schedules retries`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred()
  const started = deferred()
  const receipts = []
  const b = bench({ send: async () => {
    if (phase !== 'receipt') { started.resolve(); await gate.promise }
    if (phase === 'failed wire') throw new Error('network after stop')
    return { messageId: 91 }
  } })
  const first = b.queue.output({ chat: forum, target: { botId: 'a' } }, { text: 'In flight' }, { sent: async (receipt, chat) => {
    if (phase === 'receipt') { started.resolve(); await gate.promise }
    receipts.push([receipt.messageId, chat.threadId])
  } })
  await started.promise
  const second = b.queue.notice(forum, { text: 'Discarded' })
  let stopped = false
  const closing = b.queue.close().then(() => { stopped = true })
  await nextTurn()
  assert.equal(stopped, false)
  gate.resolve()
  await closing
  await Promise.all([first, second])
  t.mock.timers.tick(20_000)
  assert.equal(b.calls.length, 1)
  assert.deepEqual(receipts, phase === 'failed wire' ? [] : [[91, 40]])
})

test('Topic recovery is tried once and a revoked binding after recovery prevents resend', async () => {
  let recoveries = 0
  const b = bench({
    send: async () => { throw Object.assign(new Error('Topic missing'), { topicMissing: true, permanent: true }) },
    recoverTopic: async () => { recoveries++; return true },
  })
  await b.queue.output({ chat: direct, target: { botId: 'a' } }, { text: 'Missing' })
  assert.equal(recoveries, 1)
  assert.equal(b.calls.length, 2)
  assert.equal(b.statuses.length, 1)
  await b.queue.close()

  const revoked = bench({
    send: async () => { throw Object.assign(new Error('Topic missing'), { topicMissing: true }) },
    recoverTopic: async () => {
      revoked.byId[revoked.conn.id].paired[0].access = { botIds: [], roomIds: [] }
      return true
    },
  })
  await revoked.queue.output({ chat: direct, target: { botId: 'a' } }, { text: 'Revoked during recovery' })
  assert.equal(revoked.calls.length, 1)
  await revoked.queue.close()
})

const journalOf = async b => {
  const data = await b.store.of(b.conn.id)
  data.cards = {}
  return {
    data,
    cards: cardJournal({
      store: { of: b.store.of, peek: () => data, save: () => {} },
      connections: () => b.byId, handleOf: () => b.handle, deliveryOf: () => b.queue,
      textForChat: () => key => key, textForPerson: () => key => key,
      paired: (conn, id) => conn.paired.some(person => person.id === id),
      sourceOpen: () => () => true, warn: (...args) => b.warnings.push(args), readOnly: () => false,
    }),
  }
}
const card = () => ({ text: 'Allow?', options: [{ label: 'Allow', data: 'a:1:allow' }] })

for (const mode of ['original Origin', 'different Origin', 'rebound', 'Access', 'legacy', 'legacy rebound']) test(`Private public copy enforces ${mode} through real Card journal, Placement and Delivery`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const b = bench()
  const { cards, data } = await journalOf(b)
  await origin(b)
  const initiator = await b.place.initiatorOf(b.conn, 's')
  await cards.send(b.conn, 'a:1', b.place.places(b.conn, { botId: 'a' }, 's', 'card'), 'Allow?', undefined, card, initiator)
  await b.queue.notice(forum, { text: 'Private receipt barrier' })
  const privateCopy = data.cards['a:1'][0]
  assert.equal(privateCopy.receiverUserId, '9')
  assert.equal(b.calls[0].receiverUserId, '9')
  if (mode.startsWith('legacy')) delete privateCopy.output
  b.place.sessionEvent({ id: 's' }, { type: 'turn/end' })
  await origin(b, direct, 2)
  b.byId[b.conn.id] = structuredClone(b.conn)
  if (mode === 'different Origin') {
    privateCopy.output.initiator = { connectionId: b.conn.id, chatKey: direct.key, threadId: direct.threadId, sender: ann }
  }
  if (mode.includes('rebound')) b.byId[b.conn.id].chats[forum.key].topics[40].target = { botId: 'b' }
  if (mode === 'Access') b.byId[b.conn.id].paired[0].access = { botIds: [], roomIds: [] }
  t.mock.timers.tick(5 * 60 * 1000)
  await cards.expirePrivate(b.byId[b.conn.id])
  await b.queue.notice(forum, { text: 'Public receipt barrier' })
  const publicCopy = data.cards['a:1'].find(copy => copy.receiverUserId === undefined)
  const allowed = mode === 'original Origin' || mode === 'legacy'
  assert.equal(b.calls.filter(call => call.card !== undefined && call.receiverUserId === undefined).length, allowed ? 1 : 0)
  assert.equal(publicCopy.messageId !== undefined, allowed)
  assert.deepEqual(publicCopy.target, { botId: 'a' })
  assert.equal(publicCopy.output === undefined, mode.startsWith('legacy'))
  await b.queue.close()
})

for (const move of ['follow', 'recovery']) test(`Card receipt records the actual Topic after ${move}, without mutating its caller address`, async () => {
  const b = bench({
    send: async (chat) => {
      if (move === 'recovery' && chat.threadId === 101) throw Object.assign(new Error('Topic missing'), { topicMissing: true })
      return { messageId: 77 }
    },
    recoverTopic: async chat => {
      b.conn.chats['5'].topics[101].replacedBy = 102
      b.conn.chats['5'].topics[102] = { target: { botId: 'a' } }
      chat.threadId = 102
      return true
    },
  })
  const { cards, data } = await journalOf(b)
  if (move === 'follow') {
    b.conn.chats['5'].topics[101].replacedBy = 102
    b.conn.chats['5'].topics[102] = { target: { botId: 'a' } }
  }
  const address = { ...direct }
  await cards.send(b.conn, 'a:1', [{ chat: address, target: { botId: 'a' } }], 'Allow?', undefined, card)
  await b.queue.notice(direct, { text: 'Receipt barrier' })
  assert.equal(address.threadId, 101)
  assert.equal(data.cards['a:1'].length, 1)
  assert.deepEqual(data.cards['a:1'].map(copy => [copy.threadId, copy.messageId]), [[102, 77]])
  assert.equal(cards.open(b.conn, { ...direct, threadId: 102 }, 'a:1').entry.messageId, 77)
  await b.queue.close()
})
