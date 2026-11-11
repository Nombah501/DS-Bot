import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { startBridge, until } from './telegram-bridge.js'

const team = () => ({
  version: 1, mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a'], mode: 'everyone', admin: 'a', named: true, sessions: { a: 'ar1' }, log: [], seq: 0 } },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})
const setup = async t => {
  const s = await startBridge(t, { seed: team(), pair: false, getMe: { id: 7, username: 'fakebot', is_bot: true, has_topics_enabled: true } })
  let next = 100
  s.replies.createForumTopic = () => ({ ok: true, result: { message_thread_id: ++next } })
  s.message('hello')
  await s.request('sendMessage', p => /connection request/.test(p.text))
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '9', allow: true })
  await s.request('createForumTopic', p => p.name === 'Ops')
  return s
}

test('S1: /status posts and pins an offline size-bounded widget in its private Topic', async t => {
  const s = await setup(t)
  s.sessionEvent('turn/start', { turn: 1 }, 'b')
  s.sessionEvent('step/start', { step: 3 }, 'b')
  s.sessionEvent('tool/call', { callId: 'read-1', name: 'read_file', arguments: '{}' }, 'b')
  s.message('/status', { message_thread_id: 102 })
  const widget = await s.request('sendWidget')
  assert.equal(widget.params.chat_id, '5')
  assert.equal(widget.params.message_thread_id, 102)
  assert.equal(widget.params.allow_queries, true)
  const data = JSON.parse(widget.params.chat_data)
  assert.equal(data.name, 'Writer')
  assert.equal(data.state, 'Working')
  assert.equal(data.tool, 'read_file')
  assert.equal(data.step, 3)
  assert.ok(data.since > 0)
  assert.ok(Buffer.byteLength(widget.params.html) <= 32768)
  assert.ok(deflateSync(widget.params.html, { level: 9 }).length <= 4096)
  assert.doesNotMatch(widget.params.html, /https?:|fetch\(|XMLHttpRequest|WebSocket/)
  assert.doesNotMatch(widget.params.html + widget.params.chat_data, /cost|token/i)
  const pin = await s.request('pinChatMessage')
  assert.equal(pin.params.chat_id, '5')
  assert.ok(Number.isSafeInteger(pin.params.message_id))
  assert.ok(s.calls.find(c => c.method === 'getUpdates').params.allowed_updates.includes('widget_query'))
  assert.equal(s.prompts.length, 0)
})

test('S1: status data follows only its target and coalesces changes at one-second intervals', async t => {
  const s = await setup(t)
  const times = []
  s.replies.editMessageWidgetData = () => { times.push(Date.now()); return { ok: true, result: true } }
  s.message('/status', { message_thread_id: 102 })
  await s.request('pinChatMessage')
  s.sessionEvent('turn/start', { turn: 1 }, 'b')
  s.sessionEvent('step/start', { turn: 1, step: 2 }, 'b')
  s.sessionEvent('tool/call', { callId: 'first', name: 'read_file', arguments: '{}' }, 'b')
  const first = await s.request('editMessageWidgetData', p => JSON.parse(p.chat_data).tool === 'read_file')
  assert.equal(first.params.chat_id, '5')
  assert.equal(JSON.parse(first.params.chat_data).step, 2)
  assert.ok(Buffer.byteLength(first.params.chat_data) <= 1024)
  for (let i = 0; i < 100; i++) s.sessionEvent('step/start', { turn: 1, step: i + 3 }, 'b')
  s.sessionEvent('tool/call', { callId: 'latest', name: 'write_file', arguments: '{}' }, 'b')
  await delay(200)
  assert.equal(times.length, 1)
  const latest = await s.request('editMessageWidgetData', p => JSON.parse(p.chat_data).tool === 'write_file')
  assert.equal(latest.params.message_id, first.params.message_id)
  assert.equal(JSON.parse(latest.params.chat_data).step, 102)
  assert.ok(times[1] - times[0] >= 950)
  const after = s.calls.length
  s.sessionEvent('turn/start', { turn: 2 }, 'a')
  s.sessionEvent('tool/call', { callId: 'other', name: 'other_target_tool', arguments: '{}' }, 'a')
  await delay(1100)
  assert.equal(s.calls.slice(after).filter(c => c.method === 'editMessageWidgetData').length, 0)
  s.sessionEvent('turn/end', { turn: 1 }, 'b')
  const idle = await s.request('editMessageWidgetData', p => JSON.parse(p.chat_data).state === 'Idle')
  assert.equal(JSON.parse(idle.params.chat_data).active, false)
})

test('S1: Stop widget queries acknowledge promptly and authenticate the stored Topic target', async t => {
  const s = await setup(t)
  s.sessionEvent('turn/start', { turn: 1 }, 'a')
  s.sessionEvent('turn/start', { turn: 1 }, 'b')
  s.message('/status', { message_thread_id: 102 })
  const pin = await s.request('pinChatMessage')
  const query = (id, extra = {}) => s.pushUpdate({ widget_query: {
    id, chat: { id: 5, type: 'private' }, from: { id: 9, language_code: 'en' },
    message_id: pin.params.message_id, chat_instance: 'private-5', type: { type: 'data' }, data: 'stop', ...extra,
  } })
  query('unpaired', { from: { id: 99 } })
  await s.request('answerWidgetQuery', p => p.widget_query_id === 'unpaired')
  query('wrong-message', { message_id: pin.params.message_id + 1000 })
  await s.request('answerWidgetQuery', p => p.widget_query_id === 'wrong-message')
  query('wrong-chat', { chat: { id: 6, type: 'private' } })
  await s.request('answerWidgetQuery', p => p.widget_query_id === 'wrong-chat')
  query('wrong-type', { type: { type: 'sign_data' } })
  await s.request('answerWidgetQuery', p => p.widget_query_id === 'wrong-type')
  query('unknown', { data: 'not-stop' })
  await s.request('answerWidgetQuery', p => p.widget_query_id === 'unknown')
  assert.notEqual(s.agentOf('b').cancelled, true)
  const started = performance.now()
  query('stop-writer')
  await s.request('answerWidgetQuery', p => p.widget_query_id === 'stop-writer')
  assert.ok(performance.now() - started < 15000)
  await until(() => s.agentOf('b').cancelled)
  assert.notEqual(s.agentOf('a').cancelled, true)
  const stopped = await s.request('sendMessage', p => p.text === 'Stopped.')
  assert.equal(stopped.params.message_thread_id, 102)
})

test('S1: private root status supports Russian, waiting Cards and restart without duplicates', async t => {
  const s = await startBridge(t)
  s.sessionEvent('turn/start', { turn: 1 })
  await s.question({ question: 'Choose', options: [{ label: 'Yes' }] })
  const card = await s.request('sendRichMessage', p => /Choose/.test(p.rich_message.html))
  const questionId = /data="q:([^"]+):0"/.exec(card.params.rich_message.html)[1]
  s.message('/status', { from: { id: 9, first_name: 'Ann', language_code: 'ru-RU' } })
  const widget = await s.request('sendWidget')
  assert.equal(JSON.parse(widget.params.chat_data).state, 'Ждёт ответа на карточку')
  assert.match(widget.params.html, /Остановить/)
  assert.match(widget.params.html, /Инструмент/)
  assert.match(widget.params.caption, /Панель состояния/)
  assert.ok(Buffer.byteLength(widget.params.html) <= 32768)
  assert.ok(deflateSync(widget.params.html, { level: 9 }).length <= 4096)
  await s.request('pinChatMessage')
  await s.restart()
  const after = s.calls.length
  s.message('/status', { from: { id: 9, language_code: 'ru' } })
  await s.rt.answerQuestion('a', questionId, { selected: ['Yes'] })
  await s.request('editMessageWidgetData', p => JSON.parse(p.chat_data).state === 'Свободен', after)
  assert.equal(s.calls.slice(after).filter(c => c.method === 'sendWidget').length, 0)
})

test('S1: group /status is a rich snapshot with the same progress fields, never a widget', async t => {
  const s = await startBridge(t)
  const chat = { id: -20, type: 'supergroup', title: 'Team' }
  s.message('@fakebot hello', { chat })
  await s.request('sendMessage', p => p.chat_id === '-20')
  await s.rt.imEndpoint('im-chat', { id: s.connection.id, chatKey: '-20', target: { botId: 'a' } })
  s.sessionEvent('turn/start', { turn: 1 })
  s.sessionEvent('step/start', { turn: 1, step: 4 })
  s.sessionEvent('tool/call', { callId: 'group-tool', name: 'read_file', arguments: '{}' })
  s.message('/status@fakebot', { chat, from: { id: 9, language_code: 'ru' } })
  const status = await s.request('sendRichMessage', p => p.chat_id === '-20')
  assert.match(status.params.rich_message.html, /Chief.*Работает/s)
  assert.match(status.params.rich_message.html, /Инструмент: read_file/)
  assert.match(status.params.rich_message.html, /Шаг: 4/)
  assert.match(status.params.rich_message.html, /Время хода:/)
  assert.equal(s.calls.filter(c => c.method === 'sendWidget').length, 0)
})

test('S1: room Topic status Stop cancels room work, and revoked panels cannot stop or update', async t => {
  const s = await setup(t)
  s.rt.liveOf('ar1').turn = 1
  s.rt.liveOf('a').turn = 1
  s.message('/status', { message_thread_id: 103 })
  const pin = await s.request('pinChatMessage')
  s.pushUpdate({ widget_query: { id: 'room-stop', chat: { id: 5, type: 'private' }, from: { id: 9 }, message_id: pin.params.message_id, type: { type: 'data' }, data: 'stop' } })
  await until(() => s.agentOf('ar1').cancelled)
  assert.notEqual(s.agentOf('a').cancelled, true)
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: ['a'], roomIds: [] } })
  const after = s.calls.length
  s.pushUpdate({ widget_query: { id: 'revoked', chat: { id: 5, type: 'private' }, from: { id: 9 }, message_id: pin.params.message_id, type: { type: 'data' }, data: 'stop' } })
  await s.request('answerWidgetQuery', p => p.widget_query_id === 'revoked')
  await delay(1100)
  assert.equal(s.calls.slice(after).filter(c => c.method === 'editMessageWidgetData' || (c.method === 'sendMessage' && c.params.text === 'Stopped.')).length, 0)
})

test('S1: a Topic reconciliation failure cannot leave an unreachable poller after disconnect', async t => {
  const seed = team()
  seed.im = { connections: { im_start: {
    id: 'im_start', platform: 'telegram', botId: 'a', account: { id: '7', name: '@fakebot', hasTopicsEnabled: true },
    settings: { token: 'S1-FAKE-TOKEN' }, secrets: {}, enabled: true,
    paired: [{ id: '9', name: 'Ann', access: 'all', at: 1 }], requests: [],
    chats: { 5: { kind: 'direct', personId: '9', at: 1 } }, createdAt: 1,
  } } }
  const s = await startBridge(t, {
    seed, pair: false, existingConnectionId: 'im_start', waitForPoll: false,
    getMe: { id: 7, username: 'fakebot', is_bot: true, has_topics_enabled: true },
    apiReplies: { createForumTopic: { ok: false, error_code: 403, description: 'Topics temporarily unavailable' } },
  })
  await s.request('createForumTopic')
  await s.rt.imEndpoint('im-update', { id: s.connection.id, enabled: false })
  await until(() => s.activePolls === 0)
  const after = s.calls.length
  s.replies.createForumTopic = undefined
  await s.rt.imEndpoint('im-update', { id: s.connection.id, enabled: true })
  await s.request('getUpdates', () => true, after)
  await until(() => s.activePolls === 1)
  s.message('/status', { message_thread_id: 1 })
  await s.request('sendWidget', p => p.message_thread_id === 1, after)
})
