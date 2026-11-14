import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forumBinder } from '../src/host/im/forum-bind.js'
import { topics } from '../src/host/im/topics.js'

const bench = () => {
  const state = { bots: { a: { id: 'a', name: 'Chief' } }, rooms: {}, im: { connections: {} } }
  state.im.connections.c1 = {
    id: 'c1', platform: 'telegram', paired: [{ id: '9', access: 'all' }],
    chats: { forum: { kind: 'group', isForum: true } },
  }
  let saves = 0
  const notices = []
  const edits = []
  const handle = { isAdmin: async () => true, editCard: async (...args) => { edits.push(args) } }
  const rt = { state, botOf: id => state.bots[id], roomOf: id => state.rooms[id], save: async () => { saves++ } }
  const binder = forumBinder(rt, {
    connections: () => state.im.connections,
    topics: topics(rt, { connections: () => state.im.connections, handleOf: () => handle }),
    handleOf: () => handle,
    deliveryOf: () => ({ notice: async (chat, body, receipt) => { notices.push({ chat, body, receipt }) } }),
    sendText: () => {}, sendCardReply: async () => {}, textForPerson: () => key => key, may: () => true,
  })
  const msg = { chat: { key: 'forum', kind: 'group', threadId: 40 }, sender: { id: '9' } }
  return {
    state, binder, msg, notices, edits, handle, rt,
    conn: () => state.im.connections.c1,
    card: () => state.im.connections.c1.chats.forum.bindCards[40],
    saves: () => saves,
    adopt: () => { state.im.connections = structuredClone(state.im.connections) },
  }
}

test('Forum bind: a sent receipt after a second /bind cannot write the newer Card', async () => {
  const s = bench()
  await s.binder.command(s.conn(), s.msg)
  const oldId = s.card().id
  await s.binder.command(s.conn(), s.msg)
  const newer = structuredClone(s.card())
  const saves = s.saves()
  await s.notices[0].receipt.sent({ messageId: 10, cardFormat: 'rich' })
  assert.equal(s.saves(), saves, 'a superseded bind Card receipt must not write team state')
  assert.notEqual(newer.id, oldId)
  assert.deepEqual(s.card(), newer, 'the newer bind Card must remain unchanged')
  await s.notices[1].receipt.sent({ messageId: 11, cardFormat: 'rich' })
  assert.equal(s.card().messageId, 11)
})

test('Forum bind: a receipt writes the adopted Card with the same id', async () => {
  const s = bench()
  await s.binder.command(s.conn(), s.msg)
  s.adopt()
  await s.notices[0].receipt.sent({ messageId: 12, cardFormat: 'rich' })
  assert.equal(s.card().messageId, 12, 'the receipt must update the adopted bind Card')
  assert.equal(s.card().cardFormat, 'rich')
})

test('Forum bind: command resolves the chat and Access list after the admin lookup', async () => {
  const s = bench()
  s.handle.isAdmin = async () => { s.adopt(); return true }
  await s.binder.command(s.conn(), s.msg)
  assert.equal(s.card().senderId, '9')
  assert.equal(s.notices.length, 1)
  s.handle.isAdmin = async () => {
    s.adopt()
    s.conn().paired[0].access = { botIds: [], roomIds: [] }
    return true
  }
  await s.binder.command(s.conn(), s.msg)
  assert.equal(s.notices.length, 1, 'revoked Access cannot create another choice Card')
})

test('Forum bind: action binds and settles the adopted Card after every save', async () => {
  const s = bench()
  await s.binder.command(s.conn(), s.msg)
  await s.notices[0].receipt.sent({ messageId: 12, cardFormat: 'rich' })
  const id = s.card().id
  s.handle.isAdmin = async () => { s.adopt(); return true }
  const save = s.rt.save
  s.rt.save = async () => { await save(); s.adopt() }
  await s.binder.action(s.conn(), { ...s.msg, data: `b:${id}:0` })
  assert.deepEqual(s.conn().chats.forum.topics[40].target, { botId: 'a' })
  assert.equal(s.card().settled, true)
  assert.ok(s.card().card.settled)
  assert.equal(s.edits.length, 1)
  assert.equal(s.edits[0][1], 12)
  assert.deepEqual(s.edits[0][2], s.card().card)
})

test('Forum bind: a second /bind during the action admin lookup invalidates the old choice', async () => {
  const s = bench()
  await s.binder.command(s.conn(), s.msg)
  const id = s.card().id
  s.handle.isAdmin = async () => {
    s.handle.isAdmin = async () => true
    await s.binder.command(s.conn(), s.msg)
    return true
  }
  await s.binder.action(s.conn(), { ...s.msg, data: `b:${id}:0` })
  assert.notEqual(s.card().id, id)
  assert.equal(s.card().settled, undefined)
  assert.equal(s.conn().chats.forum.topics, undefined)
  assert.deepEqual(s.edits, [])
})

test('Forum bind: a newer Card created during the binding save is not settled or edited', async () => {
  const s = bench()
  await s.binder.command(s.conn(), s.msg)
  const id = s.card().id
  const save = s.rt.save
  s.rt.save = async () => {
    s.rt.save = save
    await s.binder.command(s.conn(), s.msg)
    await save()
  }
  await s.binder.action(s.conn(), { ...s.msg, data: `b:${id}:0` })
  assert.deepEqual(s.conn().chats.forum.topics[40].target, { botId: 'a' })
  assert.notEqual(s.card().id, id)
  assert.equal(s.card().settled, undefined)
  assert.equal(s.card().card.settled, undefined)
  assert.deepEqual(s.edits, [])
})

test('Forum bind: removing the chat during the admin lookup does not recreate it', async () => {
  const s = bench()
  s.handle.isAdmin = async () => { delete s.conn().chats.forum; return true }
  await s.binder.command(s.conn(), s.msg)
  assert.equal(s.conn().chats.forum, undefined)
  assert.equal(s.saves(), 0)
  assert.deepEqual(s.notices, [])
})
