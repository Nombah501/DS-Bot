import assert from 'node:assert/strict'
import { test } from 'node:test'
import { topics } from '../src/host/im/topics.js'
import { setup, telegram } from './placement-fixture.js'
import { delivery } from '../src/host/im/delivery.js'
import { translate } from '../src/host/im/locale.js'

const bench = ({ replaced = [], platform = 'telegram', deliverable = () => true } = {}) => {
  const state = { bots: { a: { id: 'a', name: 'Chief' } }, rooms: {}, im: { connections: {} } }
  state.im.connections.c1 = telegram('c1', { platform, chats: { 5: { kind: 'direct', personId: '9', topics: {} } } })
  const calls = []
  const saved = []
  let next = 100
  let connected = true
  const handle = {
    createTopic: async () => { calls.push(['create']); return { threadId: ++next } },
    send: async (chat, body) => { calls.push(['notice', chat.threadId, body.text]) },
    renameTopic: async (chat, name) => { calls.push(['rename', chat.threadId, name]) },
  }
  const rt = {
    state, botOf: id => state.bots[id], roomOf: id => state.rooms[id],
    save: async () => { saved.push(structuredClone(state)) },
  }
  const { ensure, restore, bind } = topics(rt, {
    connections: () => state.im.connections, handleOf: () => connected ? handle : undefined,
    textForChat: () => (key, values) => translate('en', key, values), deliverable, replaced,
  })
  return {
    state, calls, saved, handle, rt, ensure, restore, bind,
    disconnect: () => { connected = false },
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
  assert.deepEqual(s.calls.slice(-2), [['notice', 101, 'Topic closed: Chief is no longer on your Access list.'], ['rename', 101, 'Chief — no access']])
  assert.equal(s.chat().topics[101].closed, true)
})

test('Topics: restored Access silently renames the same Topic to its current name', async () => {
  const s = bench()
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = 'all'
  s.state.bots.a.name = 'Leader'
  await s.ensure(s.conn(), '5')
  assert.equal(s.calls.filter(([kind]) => kind === 'create').length, 1)
  assert.equal(s.chat().topics[101].closed, undefined)
  assert.equal(s.chat().topics[101].notified, undefined)
  assert.equal(s.chat().topics[101].name, 'Leader')
  assert.deepEqual(s.calls.filter(([kind]) => kind === 'rename'), [['rename', 101, 'Chief — no access'], ['rename', 101, 'Leader']])
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
  assert.deepEqual(s.calls.filter(([kind]) => kind === 'rename'), [['rename', 101, 'Chief — deleted']])
  assert.equal(s.chat().topics[101].name, 'Chief — deleted')
  assert.deepEqual(s.calls.filter(([kind]) => kind === 'notice'), [['notice', 101, 'Topic closed: Chief was deleted.']])
})

test('Topics: allowed live Topic clears a stuck notice so the next revocation notices again', async () => {
  const s = bench()
  await s.ensure(s.conn(), '5')
  s.chat().topics[101].notified = true
  const before = s.calls.length
  await s.ensure(s.conn(), '5')
  assert.equal(s.chat().topics[101].notified, undefined, 'allowed live Topic must clear its stale notified flag')
  assert.equal(s.saved.at(-1).im.connections.c1.chats[5].topics[101].notified, undefined)
  assert.equal(s.calls.length, before)
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  await s.ensure(s.conn(), '5')
  assert.deepEqual(s.calls.filter(([kind]) => kind === 'notice'), [['notice', 101, 'Topic closed: Chief is no longer on your Access list.']])
})

test('Topics: a missing Topic on restore rename is replaced and records its successor', async () => {
  const s = bench()
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = 'all'
  s.handle.renameTopic = async () => { throw Object.assign(new Error('Topic missing'), { topicMissing: true }) }
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

for (const phase of ['notice', 'revoke', 'rename', 'restore']) {
  test(`Topics: ${phase} records its result in the adopted chat`, async () => {
    const s = bench()
    await s.ensure(s.conn(), '5')
    if (phase !== 'rename') {
      s.conn().paired[0].access = { botIds: [], roomIds: [] }
      if (phase === 'restore') {
        await s.ensure(s.conn(), '5')
        s.conn().paired[0].access = 'all'
      }
    } else s.state.bots.a.name = 'Leader'
    const method = phase === 'notice' ? 'send' : 'renameTopic'
    const original = s.handle[method]
    s.handle[method] = async (...args) => { s.adopt(); return original(...args) }
    await s.ensure(s.conn(), '5')
    const count = s.calls.length
    await s.ensure(s.conn(), '5')
    assert.equal(s.calls.length, count, 'the adopted result must not repeat the wire operation')
    const saved = s.saved.at(-1).im.connections.c1.chats[5].topics[101]
    assert.equal(saved.name, phase === 'rename' ? 'Leader' : phase === 'restore' ? 'Chief' : 'Chief — no access')
    assert.equal(saved.closed, ['notice', 'revoke'].includes(phase) ? true : undefined)
    assert.equal(saved.notified, ['notice', 'revoke'].includes(phase) ? true : undefined)
  })
}

test('Topics: adoption during each save preserves notice, revoke, restore and rename writes', async () => {
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

for (const phase of ['create', 'notice', 'revoke', 'rename', 'restore']) {
  for (const removed of ['chat', 'connection']) {
    test(`Topics: ${removed} removal during ${phase} writes nothing after removal`, async () => {
      const s = bench()
      if (phase !== 'create') await s.ensure(s.conn(), '5')
      if (['notice', 'revoke', 'restore'].includes(phase)) {
        s.conn().paired[0].access = { botIds: [], roomIds: [] }
        if (phase === 'restore') {
          await s.ensure(s.conn(), '5')
          s.conn().paired[0].access = 'all'
        }
      }
      if (phase === 'rename') s.state.bots.a.name = 'Leader'
      const method = phase === 'create' ? 'createTopic' : phase === 'notice' ? 'send' : 'renameTopic'
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

test('Topics: unrelated restore rename failures leave the closed Topic for the next sweep to retry', async () => {
  const s = bench()
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = 'all'
  const rename = s.handle.renameTopic
  s.handle.renameTopic = async () => { throw new Error('offline') }
  await assert.rejects(s.ensure(s.conn(), '5'), /offline/)
  assert.equal(s.chat().topics[101].closed, true)
  assert.equal(s.chat().topics[101].replacedBy, undefined)
  assert.equal(s.calls.filter(([kind]) => kind === 'create').length, 1)
  s.handle.renameTopic = rename
  await s.ensure(s.conn(), '5')
  assert.equal(s.chat().topics[101].closed, undefined)
})

test('Topics: a platform without Topics has no lifecycle side effects', async () => {
  const s = bench({ platform: 'discord' })
  await s.ensure(s.conn(), '5')
  assert.equal(await s.restore(s.conn(), { key: '5', threadId: 101 }), undefined)
  assert.deepEqual(s.calls, [])
  assert.deepEqual(s.saved, [])
})

for (const method of ['send', 'renameTopic']) {
  test(`Topics: Access restored during ${method} renames back without creating a second live Topic`, async () => {
    const s = bench()
    await s.ensure(s.conn(), '5')
    s.conn().paired[0].access = { botIds: [], roomIds: [] }
    const original = s.handle[method]
    s.handle[method] = async (...args) => {
      s.conn().paired[0].access = 'all'
      return original(...args)
    }
    await s.ensure(s.conn(), '5')
    await s.ensure(s.conn(), '5')
    const live = Object.entries(s.chat().topics).filter(([, topic]) => !topic.closed && topic.replacedBy === undefined)
    assert.deepEqual(live.map(([id]) => Number(id)), [101], 'restoring Access during closure must leave only the original Topic live')
    assert.deepEqual(s.calls.filter(([kind]) => kind === 'rename'), [['rename', 101, 'Chief — no access'], ['rename', 101, 'Chief']])
    assert.equal(s.chat().topics[101].notified, undefined)
    assert.equal(s.calls.filter(([kind]) => kind === 'create').length, 1)
  })
}

test('Topics: a runner removed during the notice send stops the sweep without further writes', async () => {
  const s = bench()
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  const send = s.handle.send
  const saves = s.saved.length
  s.handle.send = async (...args) => { s.disconnect(); return send(...args) }
  await assert.doesNotReject(s.ensure(s.conn(), '5'), 'a runner removed during the notice must stop quietly')
  assert.equal(s.saved.length, saves, 'the stopped sweep must not write further state')
  assert.deepEqual(s.calls, [['create'], ['notice', 101, 'Topic closed: Chief is no longer on your Access list.']])
  assert.equal(s.chat().topics[101].notified, undefined)
  assert.equal(s.chat().topics[101].closed, undefined)
})

test('Topics: restore does not replace queued output whose Access was revoked', async () => {
  let place
  const s = bench({ deliverable: (conn, address, target) => place.deliverable(conn, address, { target }) })
  await s.ensure(s.conn(), '5')
  place = setup([s.conn()]).place
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  assert.equal(await s.restore(s.conn(), { key: '5', kind: 'direct', threadId: 101 }), undefined)
  assert.deepEqual(s.calls, [['create']], 'revoked queued output must not create a replacement Topic')
  assert.equal(s.chat().topics[101].replacedBy, undefined)
  assert.equal(s.saved.length, 1)
})

test('Topics: a missing Topic restored in the creation phase is replaced once', async () => {
  const events = []
  const s = bench({ replaced: [(...args) => { events.push(args) }] })
  await s.ensure(s.conn(), '5')
  s.conn().paired[0].access = { botIds: [], roomIds: [] }
  const rename = s.handle.renameTopic
  s.handle.renameTopic = async (chat, name) => {
    if (name === 'Chief — no access') {
      s.conn().paired[0].access = 'all'
      return rename(chat, name)
    }
    s.calls.push(['rename', chat.threadId, name])
    throw Object.assign(new Error('Topic missing'), { topicMissing: true })
  }
  await s.ensure(s.conn(), '5')
  await s.ensure(s.conn(), '5')
  assert.deepEqual(s.calls.filter(([kind]) => kind === 'rename'), [['rename', 101, 'Chief — no access'], ['rename', 101, 'Chief']])
  assert.equal(s.chat().topics[101].replacedBy, 102)
  assert.deepEqual(s.chat().topics[102].target, { botId: 'a' })
  assert.equal(s.calls.filter(([kind]) => kind === 'create').length, 2)
  assert.deepEqual(events, [['c1', '5', 101, 102]])
})
