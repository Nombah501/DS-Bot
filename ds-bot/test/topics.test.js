import assert from 'node:assert/strict'
import { test } from 'node:test'
import { topics } from '../src/host/im/topics.js'
import { setup, telegram } from './placement-fixture.js'
import { delivery } from '../src/host/im/delivery.js'

const bench = ({ replaced = [], capabilities = { topics: true } } = {}) => {
  const state = { bots: { a: { id: 'a', name: 'Chief' } }, rooms: {}, im: { connections: {} } }
  state.im.connections.c1 = telegram('c1', { chats: { 5: { kind: 'direct', personId: '9', topics: {} } } })
  const calls = []
  const saved = []
  let next = 100
  const handle = {
    createTopic: async () => { calls.push(['create']); return { threadId: ++next } },
    send: async (chat, body) => { calls.push(['notice', chat.threadId, body.text]) },
    closeTopic: async chat => { calls.push(['close', chat.threadId]) },
    reopenTopic: async chat => { calls.push(['reopen', chat.threadId]) },
    renameTopic: async (chat, name) => { calls.push(['rename', chat.threadId, name]) },
  }
  const rt = {
    state, botOf: id => state.bots[id], roomOf: id => state.rooms[id],
    save: async () => { saved.push(structuredClone(state)) },
  }
  const { ensure, restore, bind } = topics(rt, {
    connections: () => state.im.connections, handleOf: () => handle,
    textForChat: () => (key, values) => `${key}: ${values.name}`, deliverable: () => true,
    replaced, platformOf: () => capabilities,
  })
  return {
    state, calls, saved, handle, rt, ensure, restore, bind,
    conn: () => state.im.connections.c1,
    chat: () => state.im.connections.c1?.chats[5],
    adopt: () => { state.im.connections = structuredClone(state.im.connections) },
  }
}

test('Topics: adopt during creation does not duplicate the target on the next sweep', async () => {
  const s = bench()
  const create = s.handle.createTopic
  s.handle.createTopic = async (...args) => { s.adopt(); return create(...args) }
  await s.ensure(s.conn(), '5')
  await s.ensure(s.conn(), '5')
  assert.equal(s.calls.filter(([kind]) => kind === 'create').length, 1, 'an adopted creation must not create a duplicate on the next sweep')
  assert.deepEqual(s.saved.at(-1).im.connections.c1.chats[5].topics[101].target, { botId: 'a' })
})

test('Topics: creation during Access revocation is recorded and then noticed and closed', async () => {
  const s = bench()
  const create = s.handle.createTopic
  s.handle.createTopic = async (...args) => {
    s.conn().paired[0].access = { botIds: [], roomIds: [] }
    return create(...args)
  }
  await s.ensure(s.conn(), '5')
  assert.deepEqual(s.chat().topics[101]?.target, { botId: 'a' }, 'a Topic created during revocation must still be recorded')
  await s.ensure(s.conn(), '5')
  assert.deepEqual(s.calls.slice(-2), [['notice', 101, 'topicRevoked: Chief'], ['close', 101]])
  assert.equal(s.chat().topics[101].closed, true)
})

test('Topics: restored Access silently reopens the same Topic and updates its name', async () => {
  const s = bench()
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = 'all'
  s.state.bots.a.name = 'Leader'
  await s.ensure(s.conn(), '5')
  assert.deepEqual(s.calls.filter(([kind]) => kind === 'reopen'), [['reopen', 101]], 'restored Access must reopen its closed Topic')
  assert.equal(s.calls.filter(([kind]) => kind === 'create').length, 1)
  assert.equal(s.chat().topics[101].closed, undefined)
  assert.equal(s.chat().topics[101].notified, undefined)
  assert.equal(s.chat().topics[101].name, 'Leader')
  assert.equal(s.calls.filter(([kind]) => kind === 'notice').length, 1)
})

test('Topics: a deleted Bot leaves its Topic closed when Access is restored', async () => {
  const s = bench()
  await s.ensure(s.conn(), '5')
  delete s.state.bots.a
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = 'all'
  await s.ensure(s.conn(), '5')
  assert.equal(s.chat().topics[101].closed, true)
  assert.deepEqual(s.calls.filter(([kind]) => kind === 'reopen'), [])
  assert.deepEqual(s.calls.filter(([kind]) => kind === 'notice'), [['notice', 101, 'topicDeleted: Chief']])
})

test('Topics: a missing Topic on reopen is replaced and records its successor', async () => {
  const s = bench()
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = 'all'
  s.handle.reopenTopic = async () => { throw Object.assign(new Error('Topic missing'), { topicMissing: true }) }
  await s.ensure(s.conn(), '5')
  assert.equal(s.chat().topics[101].replacedBy, 102, 'a missing closed Topic must point to its replacement')
  assert.deepEqual(s.chat().topics[102].target, { botId: 'a' })
  await s.ensure(s.conn(), '5')
  assert.equal(s.calls.filter(([kind]) => kind === 'create').length, 2)
})

test('Topics: a running turn follows replacement instead of the Off-Telegram path', async () => {
  const s = bench()
  const conn = s.conn()
  conn.nonTelegramTurns = 'none'
  await s.ensure(conn, '5')
  const { place } = setup([conn])
  const address = { key: '5', kind: 'direct', threadId: 101 }
  await place.asked(conn, 'im:telegram:1', { id: '9' }, address)
  place.sessionEvent({ id: 'a' }, { type: 'turn/start', data: { turn: 1 } })
  place.sessionEvent({ id: 'a' }, { type: 'user/message', data: { source: { rpcId: 'im:telegram:1' } } })
  const replacement = await s.restore(conn, address)
  assert.equal(replacement, 102)
  assert.deepEqual(place.places(conn, { botId: 'a' }, 'a', 'message').map(({ chat }) => chat.threadId), [102], 'the running turn must deliver later output to its replacement Topic')
  assert.equal((await place.initiatorOf(conn, 'a')).threadId, 101, 'runtime Origin is not rewritten')
  assert.equal(await s.restore(conn, { ...address, threadId: 102 }), 103)
  const sent = []
  const queue = delivery({
    connection: s.conn, placement: place, recoverTopic: async () => false,
    setStatus: () => {}, warn: (...args) => assert.fail(args.join(' ')),
  })
  queue.attach({ send: async (chat, content) => { sent.push([chat.threadId, content.text]); return { messageId: 1 } } })
  await Promise.all(place.places(conn, { botId: 'a' }, 'a', 'message').map(output => queue.output(output, { text: 'later Step' })))
  await queue.close()
  assert.deepEqual(sent, [[103, 'later Step']], 'later output reaches the end of the replacement chain')
  assert.equal((await place.initiatorOf(conn, 'a')).threadId, 101)
})

for (const method of ['send', 'closeTopic', 'renameTopic', 'reopenTopic']) {
  test(`Topics: ${method} records its result in the adopted chat`, async () => {
    const s = bench()
    await s.ensure(s.conn(), '5')
    if (method !== 'renameTopic') {
      s.conn().paired[0].access = { botIds: [], roomIds: [] }
      if (method === 'reopenTopic') {
        await s.ensure(s.conn(), '5')
        s.conn().paired[0].access = 'all'
      }
    } else s.state.bots.a.name = 'Leader'
    const original = s.handle[method]
    s.handle[method] = async (...args) => { s.adopt(); return original(...args) }
    await s.ensure(s.conn(), '5')
    const count = s.calls.length
    await s.ensure(s.conn(), '5')
    assert.equal(s.calls.length, count, 'the adopted result must not repeat the wire operation')
    const saved = s.saved.at(-1).im.connections.c1.chats[5].topics[101]
    if (method === 'renameTopic') assert.equal(saved.name, 'Leader')
    else assert.equal(saved.closed, method === 'reopenTopic' ? undefined : true)
  })
}

test('Topics: adoption during each save preserves notice, close, reopen and rename writes', async () => {
  const s = bench()
  const save = s.rt.save
  s.rt.save = async () => { await save(); s.adopt() }
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  await s.ensure(s.conn(), '5')
  assert.equal(s.chat().topics[101].notified, true)
  assert.equal(s.chat().topics[101].closed, true)
  s.conn().paired[0].access = 'all'
  s.state.bots.a.name = 'Leader'
  await s.ensure(s.conn(), '5')
  assert.equal(s.chat().topics[101].closed, undefined)
  assert.equal(s.chat().topics[101].notified, undefined)
  assert.equal(s.chat().topics[101].name, 'Leader')
})

for (const method of ['createTopic', 'send', 'closeTopic', 'renameTopic', 'reopenTopic']) {
  for (const removed of ['chat', 'connection']) {
    test(`Topics: ${removed} removal during ${method} writes nothing after removal`, async () => {
      const s = bench()
      if (method !== 'createTopic') await s.ensure(s.conn(), '5')
      if (['send', 'closeTopic', 'reopenTopic'].includes(method)) {
        s.conn().paired[0].access = { botIds: [], roomIds: [] }
        if (method === 'reopenTopic') {
          await s.ensure(s.conn(), '5')
          s.conn().paired[0].access = 'all'
        }
      }
      if (method === 'renameTopic') s.state.bots.a.name = 'Leader'
      const original = s.handle[method]
      let savesAtRemoval
      s.handle[method] = async (...args) => {
        savesAtRemoval = s.saved.length
        if (removed === 'chat') delete s.conn().chats[5]
        else delete s.state.im.connections.c1
        return original(...args)
      }
      await s.ensure(s.conn(), '5')
      assert.notEqual(savesAtRemoval, undefined)
      assert.equal(s.saved.length, savesAtRemoval)
      assert.equal(s.chat(), undefined)
    })
  }
}

test('Topics: replacement after adoption saves once and notifies each subscriber once', async () => {
  const events = []
  const s = bench({ replaced: [
    (...args) => { events.push(['drafts', ...args]); assert.equal(s.saved.at(-1).im.connections.c1.chats[5].topics[101].replacedBy, 102) },
    async (...args) => { events.push(['cards', ...args]) },
    (...args) => { events.push(['panels', ...args]) },
  ] })
  await s.ensure(s.conn(), '5')
  const create = s.handle.createTopic
  s.handle.createTopic = async (...args) => { s.adopt(); return create(...args) }
  const address = { key: '5', kind: 'direct', threadId: 101 }
  assert.deepEqual(await Promise.all([s.restore(s.conn(), address), s.restore(s.conn(), address)]), [102, 102])
  assert.equal(await s.restore(s.conn(), address), 102)
  assert.deepEqual(events, [
    ['drafts', 'c1', '5', 101, 102], ['cards', 'c1', '5', 101, 102], ['panels', 'c1', '5', 101, 102],
  ])
  assert.equal(s.saved.length, 2)
  assert.equal(s.calls.filter(([kind]) => kind === 'create').length, 2)
})

test('Topics: unrelated reopen failures leave the closed Topic for the next sweep to retry', async () => {
  const s = bench()
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = 'all'
  const reopen = s.handle.reopenTopic
  s.handle.reopenTopic = async () => { throw new Error('offline') }
  await assert.rejects(s.ensure(s.conn(), '5'), /offline/)
  assert.equal(s.chat().topics[101].closed, true)
  assert.equal(s.chat().topics[101].replacedBy, undefined)
  assert.equal(s.calls.filter(([kind]) => kind === 'create').length, 1)
  s.handle.reopenTopic = reopen
  await s.ensure(s.conn(), '5')
  assert.equal(s.chat().topics[101].closed, undefined)
})

test('Topics: a platform without Topics has no lifecycle side effects', async () => {
  const s = bench({ capabilities: {} })
  await s.ensure(s.conn(), '5')
  assert.equal(await s.restore(s.conn(), { key: '5', threadId: 101 }), undefined)
  assert.deepEqual(s.calls, [])
  assert.deepEqual(s.saved, [])
})
