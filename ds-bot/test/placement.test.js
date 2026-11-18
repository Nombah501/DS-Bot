import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup, telegram } from './placement-fixture.js'

// A turn of Bot a started by a Telegram message from `address` on `conn`.
const turnFrom = async ({ place }, conn, address) => {
  await place.asked(conn, 'im:telegram:1', { id: '9', name: 'Ann' }, address)
  place.sessionEvent({ id: 'a' }, { type: 'turn/start', data: { turn: 1 } })
  place.sessionEvent({ id: 'a' }, { type: 'user/message', data: { source: { rpcId: 'im:telegram:1' } } })
}
const addresses = list => list.map(({ chat }) => [chat.key, chat.threadId])

test('Placement: output of a turn started in a private Topic goes only to that Topic', async () => {
  const conn = telegram()
  const s = setup([conn])
  await turnFrom(s, conn, { key: '5', kind: 'direct', threadId: 101 })
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'message')), [['5', 101]])
})

// An Off-Telegram turn: the session event carries no Telegram request.
const offTelegramTurn = ({ place }) => {
  place.sessionEvent({ id: 'a' }, { type: 'turn/start', data: { turn: 1 } })
  place.sessionEvent({ id: 'a' }, { type: 'user/message', data: { source: { kind: 'user' } } })
}

test('Placement: a forum-thread Origin keeps Steps, Drafts and Cards out of the private chat', async () => {
  const conn = telegram()
  const s = setup([conn])
  await turnFrom(s, conn, { key: '-60', kind: 'group', threadId: 40 })
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'message')), [['-60', 40]])
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'card')), [['-60', 40]])
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'draft')), [])
})

test('Placement: a message in the forum General topic reaches the Default Bot there', async () => {
  const conn = telegram()
  const s = setup([conn])
  assert.deepEqual(s.place.targetOf(conn, { key: '-60', kind: 'group' }), { botId: 'a' })
  await turnFrom(s, conn, { key: '-60', kind: 'group' })
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'message')), [['-60', 1]])
})

test('Placement: an Off-Telegram turn follows the connection setting, private chats only', async () => {
  for (const [setting, message, card] of [
    ['all', [['5', 101]], [['5', 101]]],
    ['cards', [], [['5', 101]]],
    ['none', [], []],
  ]) {
    const conn = telegram('c1', { nonTelegramTurns: setting })
    const s = setup([conn])
    offTelegramTurn(s)
    assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'message')), message, setting)
    assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'typing')), message, setting)
    assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'card')), card, setting)
  }
})

test('Placement: without topic mode the private chat root carries the Default Bot', async () => {
  const conn = telegram('c1', { account: {}, chats: { 5: { kind: 'direct', personId: '9' } } })
  const s = setup([conn])
  offTelegramTurn(s)
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'message')), [['5', undefined]])
})

test('Placement: an Origin unbound mid-turn makes the rest of the turn Off-Telegram', async () => {
  const conn = telegram()
  const s = setup([conn])
  await turnFrom(s, conn, { key: '-60', kind: 'group', threadId: 40 })
  delete conn.chats['-60'].topics[40]
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'message')), [['5', 101]])
})

test('Placement: an Access list without the Bot leaves its turn no place', async () => {
  const conn = telegram('c1', { paired: [{ id: '9', name: 'Ann', access: { botIds: [], roomIds: [] } }] })
  const s = setup([conn])
  await turnFrom(s, conn, { key: '5', kind: 'direct', threadId: 101 })
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'message')), [])
  assert.equal(s.place.deliverable(conn, { key: '5', kind: 'direct', threadId: 101 }, { target: { botId: 'a' } }), false)
})

test('Placement: a closed Topic takes nothing; a replaced Topic hands over to its replacement', async () => {
  const closed = telegram()
  closed.chats[5].topics[101].closed = true
  const s1 = setup([closed])
  offTelegramTurn(s1)
  assert.deepEqual(addresses(s1.place.places(closed, { botId: 'a' }, 'a', 'message')), [])
  assert.equal(s1.place.deliverable(closed, { key: '5', kind: 'direct', threadId: 101 }, { target: { botId: 'a' } }), false)

  const replaced = telegram()
  replaced.chats[5].topics[101].replacedBy = 102
  replaced.chats[5].topics[102] = { target: { botId: 'a' }, name: 'Chief' }
  const s2 = setup([replaced])
  offTelegramTurn(s2)
  assert.deepEqual(addresses(s2.place.places(replaced, { botId: 'a' }, 'a', 'message')), [['5', 102]])
  const queued = { key: '5', kind: 'direct', threadId: 101 }
  s2.place.follow(replaced, queued)
  assert.equal(queued.threadId, 102)
})

test('Placement: an Origin on one connection keeps the turn off every other connection', async () => {
  const first = telegram('c1')
  const second = telegram('c2')
  const s = setup([first, second])
  await turnFrom(s, first, { key: '5', kind: 'direct', threadId: 101 })
  assert.deepEqual(addresses(s.place.places(first, { botId: 'a' }, 'a', 'message')), [['5', 101]])
  assert.deepEqual(addresses(s.place.places(second, { botId: 'a' }, 'a', 'message')), [])
  assert.deepEqual(await s.place.initiatorOf(second, 'a'), { sender: { id: '9', name: 'Ann' }, connectionId: 'c1', chatKey: '5', threadId: 101 })
})

test('Placement: a turn ends its Origin; the next turn without Telegram is Off-Telegram', async () => {
  const conn = telegram()
  const s = setup([conn])
  await turnFrom(s, conn, { key: '-60', kind: 'group', threadId: 40 })
  s.place.sessionEvent({ id: 'a' }, { type: 'turn/end', data: { turn: 1 } })
  offTelegramTurn(s)
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'message')), [['5', 101]])
})

test('Placement: a platform without Topics answers only the asking binding of the Bot', async () => {
  const conn = { id: 'd1', platform: 'discord', botId: 'a', paired: [{ id: '9' }], chats: { g: { kind: 'group', target: { botId: 'a' } }, d: { kind: 'direct' }, other: { kind: 'group', target: { botId: 'b' } } } }
  const s = setup([conn])
  assert.deepEqual(s.place.places(conn, { botId: 'a' }, 'a', 'message'), [])
  await turnFrom(s, conn, { key: 'g', kind: 'group' })
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'message')), [['g', undefined]])
})

test('Placement: DS Bot group chat lines go to every binding of the group, whatever the Origin', async () => {
  const conn = telegram()
  conn.chats.g = { kind: 'group', target: { roomId: 'r' } }
  conn.chats['-60'].topics[41] = { target: { roomId: 'r' } }
  conn.chats['-60'].topics[42] = { target: { roomId: 'r' } }
  const s = setup([conn])
  await turnFrom(s, conn, { key: '5', kind: 'direct', threadId: 101 })
  assert.deepEqual(addresses(s.place.places(conn, { roomId: 'r' }, 'r', 'message')), [['-60', 41], ['-60', 42], ['g', undefined]])
})

test('Placement: queued output keeps its own turn\'s Origin after that turn ends, until the Origin is unbound', async () => {
  const conn = telegram()
  const s = setup([conn])
  await turnFrom(s, conn, { key: '5', kind: 'direct', threadId: 101 })
  const [queued] = s.place.places(conn, { botId: 'a' }, 'a', 'message')
  conn.nonTelegramTurns = 'cards'
  s.place.sessionEvent({ id: 'a' }, { type: 'turn/end', data: { turn: 1 } })
  await s.place.asked(conn, 'im:telegram:2', { id: '9', name: 'Ann' }, { key: '-60', kind: 'group', threadId: 40 })
  s.place.sessionEvent({ id: 'a' }, { type: 'turn/start', data: { turn: 2 } })
  s.place.sessionEvent({ id: 'a' }, { type: 'user/message', data: { source: { rpcId: 'im:telegram:2' } } })
  assert.equal(s.place.deliverable(conn, queued.chat, queued), true, 'a later turn elsewhere does not move it')
  conn.chats['5'].topics[101].closed = true
  assert.equal(s.place.deliverable(conn, queued.chat, queued), false)
})

test('Placement: switching to "only Cards" stops queued Step messages but not queued Cards', async () => {
  const conn = telegram()
  const s = setup([conn])
  offTelegramTurn(s)
  const [step] = s.place.places(conn, { botId: 'a' }, 'a', 'message')
  const [card] = s.place.places(conn, { botId: 'a' }, 'a', 'card')
  conn.nonTelegramTurns = 'cards'
  assert.equal(s.place.deliverable(conn, step.chat, step), false)
  assert.equal(s.place.deliverable(conn, card.chat, card), true)
})

test('Placement: a forum thread bound to another Bot takes no more queued output of the old one', async () => {
  const conn = telegram()
  const s = setup([conn])
  await turnFrom(s, conn, { key: '-60', kind: 'group', threadId: 40 })
  const [queued] = s.place.places(conn, { botId: 'a' }, 'a', 'message')
  const reply = { chat: { key: '-60', kind: 'group', threadId: 40 }, target: s.place.targetOf(conn, { key: '-60', kind: 'group', threadId: 40 }) }
  conn.chats['-60'].topics[40] = { target: { botId: 'b' } }
  assert.equal(s.place.deliverable(conn, queued.chat, queued), false)
  assert.equal(s.place.deliverable(conn, reply.chat, { target: reply.target }), false)
  assert.equal(s.place.deliverable(conn, reply.chat, {}), true, 'a Bridge reply without a target only needs the chat')
})

test('Placement: a Paired person may use only what the Access list holds, and anything without Topics', async () => {
  const conn = telegram('c1', { paired: [{ id: '9', name: 'Ann', access: { botIds: ['a'], roomIds: [] } }] })
  const discord = { id: 'd1', platform: 'discord', botId: 'a', paired: [{ id: '9', access: { botIds: [], roomIds: [] } }], chats: {} }
  const s = setup([conn, discord])
  assert.equal(s.place.may(conn, '9', { botId: 'a' }), true)
  assert.equal(s.place.may(conn, '9', { botId: 'b' }), false)
  assert.equal(s.place.may(conn, '7', { botId: 'a' }), false, 'not paired')
  assert.equal(s.place.may(discord, '9', { botId: 'b' }), true)
})

test('Placement: an address alone names its Bot or group, on every platform', async () => {
  const discord = { id: 'd1', platform: 'discord', botId: 'a', paired: [], chats: { g: { kind: 'group', target: { roomId: 'r' } }, d: { kind: 'direct' } } }
  const conn = telegram()
  const s = setup([conn, discord])
  assert.deepEqual(s.place.targetOf(discord, { key: 'g', kind: 'group' }), { roomId: 'r' })
  assert.deepEqual(s.place.targetOf(discord, { key: 'd' }), { botId: 'a' })
  assert.deepEqual(s.place.targetOf(conn, { key: '5', kind: 'direct', threadId: 101 }), { botId: 'a' })
  assert.equal(s.place.targetOf(conn, { key: 'unknown', kind: 'group' }), undefined)
})

test('Placement: non-Topic group lines answer only the asking chat and replay rechecks binding and pairing', async () => {
  const conn = { id: 'd1', platform: 'discord', paired: [{ id: '9' }], chats: {
    g1: { kind: 'group', target: { roomId: 'r' } }, g2: { kind: 'group', target: { roomId: 'r' } },
  } }
  const s = setup([conn])
  await s.place.asked(conn, 'im:discord:room', { id: '9' }, { key: 'g1', kind: 'group' })
  s.place.sessionEvent({ id: 'r' }, { type: 'turn/start', data: { turn: 1 } })
  s.place.sessionEvent({ id: 'r' }, { type: 'user/message', data: { source: { rpcId: 'im:discord:room' } } })
  const [queued] = s.place.places(conn, { roomId: 'r' }, 'r', 'message')
  assert.deepEqual(addresses(s.place.places(conn, { roomId: 'r' }, 'r', 'message')), [['g1', undefined]])
  conn.paired = []
  assert.equal(s.place.deliverable(conn, queued.chat, queued), false)
  conn.paired = [{ id: '9' }]
  assert.equal(s.place.deliverable(conn, queued.chat, queued), true)
  delete conn.chats.g1.target
  assert.equal(s.place.deliverable(conn, queued.chat, queued), false)
})

test('Placement: Telegram holds its Initiator across a part switch and releases the token', async () => {
  const conn = telegram()
  const s = setup([conn])
  await turnFrom(s, conn, { key: '-60', kind: 'group', threadId: 40 })
  const token = s.place.holdOrigin('a')
  s.place.sessionEvent({ id: 'a' }, { type: 'turn/end', data: { turn: 1 } })
  s.place.peekOrigin('next', token)
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'next', 'message')), [['-60', 40]])
  s.place.sessionEvent({ id: 'next' }, { type: 'turn/start', data: { turn: 2 } })
  s.place.sessionEvent({ id: 'next' }, { type: 'user/message', data: { source: { imOrigin: token } } })
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'next', 'message')), [['-60', 40]])
  s.place.dropOrigin(token)
  s.place.sessionEvent({ id: 'other' }, { type: 'turn/start', data: { turn: 3 } })
  s.place.sessionEvent({ id: 'other' }, { type: 'user/message', data: { source: { imOrigin: token } } })
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'other', 'message')), [['5', 101]])
})

test('Placement: later Paired people and a Web steer do not change Telegram Initiator', async () => {
  const conn = telegram()
  conn.paired.push({ id: '10', access: 'all' })
  const s = setup([conn])
  await turnFrom(s, conn, { key: '-60', kind: 'group', threadId: 40 })
  await s.place.asked(conn, 'im:telegram:join', { id: '10' }, { key: '5', kind: 'direct', threadId: 101 })
  s.place.sessionEvent({ id: 'a' }, { type: 'user/message', data: { source: { rpcId: 'im:telegram:join' } } })
  s.place.sessionEvent({ id: 'a' }, { type: 'user/message', data: { source: { kind: 'web' } } })
  assert.equal((await s.place.initiatorOf(conn, 'a')).sender.id, '9')
  assert.deepEqual(addresses(s.place.places(conn, { botId: 'a' }, 'a', 'message')), [['-60', 40]])
})

test('Placement: a non-Topic queued send keeps the binding captured at arrival even after in-place edits', async () => {
  const conn = { id: 'd1', platform: 'discord', paired: [{ id: '9' }], chats: { g: { kind: 'group', target: { botId: 'a' } } } }
  const s = setup([conn])
  await turnFrom(s, conn, { key: 'g', kind: 'group' })
  const [queued] = s.place.places(conn, { botId: 'a' }, 'a', 'message')
  assert.ok(queued)
  conn.chats.g.target.botId = 'b'
  assert.equal(s.place.deliverable(conn, queued.chat, queued), false)
})
