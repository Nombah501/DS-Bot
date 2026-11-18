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
const bench = ({ conn = telegram(), send, sending, recoverTopic, attach = true, state = { queues: new Map() } } = {}) => {
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
    connection: () => env.byId[conn.id], placement: env.place, sending, recoverTopic, state,
    setStatus: (_key, status) => { if (status !== undefined) statuses.push(status) }, warn: (...args) => warnings.push(args),
  })
  if (attach) queue.attach(handle)
  return { ...env, conn, queue, handle, calls, statuses, warnings, state }
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
  const destination = { chat: { key: 'dm', kind: 'direct' }, target: { botId: 'a' } }
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

for (const kind of ['permanent', 'unknown', 'stopped']) test(`${kind} failures release the queue; only permanent sends are retained for replay`, async t => {
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
  await b.queue.retry()
  await nextTurn()
  assert.deepEqual(b.calls.map(call => call.text), kind === 'permanent' ? ['Refused', 'Next', 'Refused'] : ['Refused', 'Next'])
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

for (const stage of ['retry', 'Draft', 'recovery']) test(`close retains work during ${stage} for a new runner without reviving the old handle`, async t => {
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
  const second = b.queue.output({ chat: direct, target: { botId: 'a' } }, { text: 'Follower' })
  await b.queue.close()
  await Promise.all([first, second])
  const attempts = b.calls.length
  const replay = bench({ state: b.state })
  replay.queue.retry()
  await nextTurn()
  assert.deepEqual(replay.calls.map(call => call.text), stage === 'Draft' ? [] : ['Held', 'Follower'])
  await b.queue.notice(direct, { text: 'After close' })
  b.queue.attach(b.handle)
  gate.resolve()
  await nextTurn()
  t.mock.timers.tick(20_000)
  await nextTurn()
  assert.equal(b.calls.length, attempts)
  assert.deepEqual(replay.calls.map(call => call.text), ['Held', 'Follower'], 'the final waits for the old in-flight Draft even across replay')
  assert.equal(attempts, stage === 'Draft' ? 0 : 1)
  await replay.queue.close()
})

for (const phase of ['wire', 'receipt', 'failed wire', 'dropped wire']) test(`close retains followers behind an in-flight ${phase} across replay`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred()
  const started = deferred()
  const receipts = []
  const b = bench({ send: async () => {
    if (phase !== 'receipt') { started.resolve(); await gate.promise }
    if (phase === 'failed wire') throw new Error('network after stop')
    if (phase === 'dropped wire') throw Object.assign(new Error('adapter dropped'), { stopped: true })
    return { messageId: 91 }
  } })
  const first = b.queue.output({ chat: forum, target: { botId: 'a' } }, { text: 'In flight' }, { sent: async (receipt, chat) => {
    if (phase === 'receipt') { started.resolve(); await gate.promise }
    receipts.push([receipt.messageId, chat.threadId])
  } })
  await started.promise
  const second = b.queue.notice(forum, { text: 'Follower' })
  let stopped = false
  const closing = b.queue.close().then(() => { stopped = true })
  await nextTurn()
  assert.equal(stopped, false)
  const replay = bench({ state: b.state })
  replay.queue.retry()
  await nextTurn()
  assert.deepEqual(replay.calls, [], 'the old wire attempt must settle before replayed followers')
  gate.resolve()
  await closing
  await Promise.all([first, second])
  t.mock.timers.tick(20_000)
  assert.equal(b.calls.length, 1)
  assert.deepEqual(receipts, phase === 'dropped wire' ? [] : [[phase === 'failed wire' ? 1 : 91, 40]])
  await nextTurn()
  assert.deepEqual(replay.calls.map(call => call.text), phase === 'failed wire' ? ['In flight', 'Follower'] : ['Follower'])
  await replay.queue.close()
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

test('four failed attempts retain the Step, release its queue, and replay its original receipt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let failing = true
  const receipts = []
  const b = bench({ send: async (_chat, content) => {
    if (failing && content.text === 'First') throw new Error('offline')
    return { messageId: content.text }
  } })
  const destination = { chat: forum, target: { botId: 'a' } }
  const first = b.queue.output(destination, { text: 'First' }, { sent: receipt => receipts.push(receipt.messageId) })
  const next = b.queue.output(destination, { text: 'Next' })
  await nextTurn()
  for (const wait of [5000, 10000, 20000]) {
    t.mock.timers.tick(wait - 1)
    await nextTurn()
    const before = b.calls.length
    t.mock.timers.tick(1)
    await nextTurn()
    assert.ok(b.calls.length > before)
  }
  await Promise.all([first, next])
  assert.deepEqual(b.calls.map(call => call.text), ['First', 'First', 'First', 'First', 'Next'])
  assert.match(b.statuses.at(-1).error, /after 4 attempts/)
  assert.deepEqual(receipts, [])
  failing = false
  b.queue.retry()
  await nextTurn()
  assert.deepEqual(receipts, ['First'])
  await b.queue.close()
})

test('Telegram retryAfter above thirty seconds is authoritative and consumes all four attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const b = bench({ send: async () => { throw Object.assign(new Error('flood control'), { status: 429, retryAfter: 65 }) } })
  const result = b.queue.notice(forum, { text: 'Limited' })
  await nextTurn()
  for (let attempt = 1; attempt < 4; attempt++) {
    t.mock.timers.tick(64_999)
    await nextTurn()
    assert.equal(b.calls.length, attempt)
    t.mock.timers.tick(1)
    await nextTurn()
    assert.equal(b.calls.length, attempt + 1)
  }
  await result
  assert.match(b.statuses.at(-1).error, /after 4 attempts/)
  t.mock.timers.tick(65000)
  assert.equal(b.calls.length, 4)
  await b.queue.close()
})

for (const revoke of ['unbind', 'Access']) test(`replay drops a Retained send after ${revoke} revocation`, async () => {
  const b = bench({ send: async () => { throw Object.assign(new Error('forbidden'), { permanent: true }) } })
  const address = revoke === 'unbind' ? forum : direct
  await origin(b, address)
  await b.queue.output(b.place.places(b.conn, { botId: 'a' }, 's', 'message')[0], { text: 'Retained' })
  if (revoke === 'unbind') delete b.conn.chats[forum.key].topics[40].target
  else b.conn.paired[0].access = { botIds: [], roomIds: [] }
  b.queue.retry()
  await nextTurn()
  assert.equal(b.calls.length, 1)
  await b.queue.close()
})

test('an interrupted send stays after older Retained sends and before its queued followers', async () => {
  const entered = deferred()
  const release = deferred()
  const b = bench({ send: async (_chat, content) => {
    if (content.text === 'Older') throw Object.assign(new Error('blocked'), { permanent: true })
    entered.resolve()
    await release.promise
    throw new Error('interrupted')
  } })
  await b.queue.notice(forum, { text: 'Older' })
  const head = b.queue.notice(forum, { text: 'Interrupted' })
  await entered.promise
  const follower = b.queue.notice(forum, { text: 'Follower' })
  const closing = b.queue.close()
  release.resolve()
  await Promise.all([closing, head, follower])
  const replay = bench({ state: b.state })
  replay.queue.retry()
  await nextTurn()
  assert.deepEqual(replay.calls.map(call => call.text), ['Older', 'Interrupted', 'Follower'])
  await replay.queue.close()
})

test('a Retained send keeps its single Topic recovery allowance across runner replacement', async () => {
  let recoveries = 0
  const send = async () => { throw Object.assign(new Error('missing'), { topicMissing: true, permanent: true }) }
  const recoverTopic = async () => { recoveries++; return true }
  const b = bench({ send, recoverTopic })
  await b.queue.output({ chat: direct, target: { botId: 'a' } }, { text: 'Retained' })
  assert.equal(recoveries, 1)
  await b.queue.close()
  const replay = bench({ state: b.state, send, recoverTopic })
  replay.queue.retry()
  await nextTurn()
  assert.equal(replay.calls.length, 1)
  assert.equal(recoveries, 1)
  await replay.queue.close()
})
