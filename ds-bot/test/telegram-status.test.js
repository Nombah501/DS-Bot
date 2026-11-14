import assert from 'node:assert/strict'
import { test } from 'node:test'
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

const status = async (s, threadId, extra = {}) => {
  const after = s.calls.length
  const messageId = 700
  s.replies.sendRichMessage = { ok: true, result: { message_id: messageId } }
  s.message('/status', { message_thread_id: threadId, ...extra })
  const sent = await s.request('sendRichMessage', p => p.chat_id === '5', after)
  const data = /type="callback_data" data="([^"]+)"/.exec(sent.params.rich_message.html)?.[1]
  return { sent, data, messageId }
}
const press = (s, id, snapshot, threadId, { from = { id: 9, language_code: 'en' }, message = {}, data = snapshot.data } = {}) => {
  s.pushUpdate({ callback_query: {
    id, from, data,
    message: { message_id: snapshot.messageId, chat: { id: 5, type: 'private' }, message_thread_id: threadId, ...message },
  } })
}

test('S1: private /status sends an active snapshot in its Topic and Stop settles it once', async t => {
  const s = await setup(t)
  s.sessionEvent('turn/start', { turn: 1 }, 'a')
  s.sessionEvent('turn/start', { turn: 1 }, 'b')
  s.sessionEvent('step/start', { step: 3 }, 'b')
  s.sessionEvent('tool/call', { callId: 'read-1', name: 'read_file', arguments: '{}' }, 'b')
  const snapshot = await status(s, 102)
  const html = snapshot.sent.params.rich_message.html
  assert.equal(snapshot.sent.params.message_thread_id, 102)
  assert.match(html, /Writer.*Working/s)
  assert.match(html, /Tool: read_file/)
  assert.match(html, /Step: 3/)
  assert.match(html, /Turn elapsed: \d+ s/)
  assert.match(html, />Stop<\/tg-button>/)
  assert.match(snapshot.data, /^t:[0-9a-f-]{36}:stop$/)
  assert.ok(Buffer.byteLength(snapshot.data) <= 64)
  let stops = 0
  const stop = s.rt.stopChat
  s.rt.stopChat = async botId => { stops++; assert.equal(botId, 'b'); return stop(botId) }
  press(s, 'stop-writer', snapshot, 102)
  await s.request('answerCallbackQuery', p => p.callback_query_id === 'stop-writer' && p.text === 'Stopped.')
  await until(() => s.agentOf('b').cancelled)
  assert.notEqual(s.agentOf('a').cancelled, true)
  const edited = await s.request('editMessageText', p => p.message_id === snapshot.messageId)
  assert.match(edited.params.rich_message.html, /— Stopped\./)
  assert.doesNotMatch(edited.params.rich_message.html, /type="callback_data"/)
  press(s, 'stop-again', snapshot, 102)
  await s.request('answerCallbackQuery', p => p.callback_query_id === 'stop-again' && p.text === 'Nothing is running.')
  assert.equal(stops, 1)
  assert.equal(s.calls.some(c => c.method === 'sendWidget' || c.method === 'pinChatMessage'), false)
  assert.equal(s.prompts.length, 0)
})

test('S1: idle private /status sends snapshot text in its Topic without a widget or pin', async t => {
  const s = await setup(t)
  const snapshot = await status(s, 102)
  assert.equal(snapshot.sent.params.message_thread_id, 102)
  assert.match(snapshot.sent.params.rich_message.html, /Writer — Idle/)
  assert.match(snapshot.sent.params.rich_message.html, /Tool: —/)
  assert.match(snapshot.sent.params.rich_message.html, /Step: 0/)
  assert.match(snapshot.sent.params.rich_message.html, /Turn elapsed: 0 s/)
  assert.equal(snapshot.data, undefined)
  assert.doesNotMatch(snapshot.sent.params.rich_message.html, /<tg-button/)
  assert.equal(s.calls.some(c => c.method === 'sendWidget' || c.method === 'pinChatMessage'), false)
  assert.equal(s.prompts.length, 0)
})

test('S1: private status Stop authenticates the paired person and stored Topic target', async t => {
  const s = await setup(t)
  s.message('hello', { chat: { id: 6, type: 'private' }, from: { id: 10, first_name: 'Ben', language_code: 'en' } })
  await s.request('sendMessage', p => p.chat_id === '6' && /connection request/.test(p.text))
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '10', allow: true, access: { botIds: [], roomIds: [] } })
  s.sessionEvent('turn/start', { turn: 1 }, 'b')
  const snapshot = await status(s, 102)
  let stops = 0
  s.rt.stopChat = async () => { stops++; return true }
  for (const [id, options, reply] of [
    ['unpaired', { from: { id: 99 } }, 'This Bot or group is not on your Access list.'],
    ['denied', { from: { id: 10 } }, 'This Bot or group is not on your Access list.'],
    ['wrong-message', { message: { message_id: snapshot.messageId + 1 } }, 'Nothing is running.'],
    ['wrong-chat', { message: { chat: { id: 6, type: 'private' } } }, 'Nothing is running.'],
    ['wrong-topic', { message: { message_thread_id: 101 } }, 'Nothing is running.'],
    ['unknown', { data: snapshot.data.replace(/:stop$/, ':other') }, 'Nothing is running.'],
  ]) {
    press(s, id, snapshot, 102, options)
    await s.request('answerCallbackQuery', p => p.callback_query_id === id && p.text === reply)
    assert.equal(stops, 0)
  }
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: ['a'], roomIds: [] } })
  press(s, 'revoked', snapshot, 102)
  await s.request('answerCallbackQuery', p => p.callback_query_id === 'revoked' && /Access list|Nothing is running/.test(p.text))
  assert.equal(stops, 0)
  const after = s.calls.length
  s.message('/status', { message_thread_id: 102 })
  await s.request('sendMessage', p => p.message_thread_id === 102 && /not on your Access list/.test(p.text), after)
  assert.equal(s.calls.slice(after).some(c => c.method === 'sendRichMessage' || c.method === 'sendWidget' || c.method === 'pinChatMessage'), false)
})

test('S1: private root status supports Russian waiting Cards and settles when work ends', async t => {
  const s = await startBridge(t)
  await s.question({ question: 'Choose', options: [{ label: 'Yes' }] })
  const card = await s.request('sendRichMessage', p => /Choose/.test(p.rich_message.html))
  const questionId = /data="q:([^"]+):0"/.exec(card.params.rich_message.html)[1]
  const snapshot = await status(s, undefined, { from: { id: 9, first_name: 'Ann', language_code: 'ru-RU' } })
  assert.equal(snapshot.sent.params.message_thread_id, undefined)
  assert.match(snapshot.sent.params.rich_message.html, /Chief — Ждёт ответа на карточку/)
  assert.match(snapshot.sent.params.rich_message.html, /Инструмент: —/)
  assert.match(snapshot.sent.params.rich_message.html, /Остановить/)
  await s.rt.answerQuestion('a', questionId, { selected: ['Yes'] })
  press(s, 'finished', snapshot, undefined, { from: { id: 9, language_code: 'ru' } })
  await s.request('answerCallbackQuery', p => p.callback_query_id === 'finished' && p.text === 'Сейчас ничего не выполняется.')
  const settled = await s.request('editMessageText', p => p.message_id === snapshot.messageId)
  assert.doesNotMatch(settled.params.rich_message.html, /type="callback_data"/)
  assert.notEqual(s.agentOf('a').cancelled, true)
})

test('S1: private /status in an unbound Topic cannot reach the Default Bot', async t => {
  const s = await setup(t)
  s.sessionEvent('turn/start', { turn: 1 })
  const after = s.calls.length
  s.message('/status', { message_thread_id: 999 })
  await s.request('sendMessage', p => p.message_thread_id === 999 && /not bound/.test(p.text), after)
  assert.equal(s.calls.slice(after).some(c => c.method === 'sendRichMessage' || c.method === 'sendWidget' || c.method === 'pinChatMessage'), false)
  assert.equal(s.prompts.length, 0)
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
  assert.match(status.params.rich_message.html, /<tg-button type="callback_data" data="[^"]+">Остановить<\/tg-button>/)
  const callback = status.params.rich_message.html.match(/data="([^"]+)"/)[1]
  assert.ok(Buffer.byteLength(callback) <= 64)
  assert.equal(s.calls.filter(c => c.method === 'sendWidget').length, 0)
})

test('S1: private room Topic status Stop cancels room work without stopping the Bot own chat', async t => {
  const s = await setup(t)
  s.rt.liveOf('ar1').turn = 1
  s.rt.liveOf('a').turn = 1
  const snapshot = await status(s, 103)
  assert.match(snapshot.sent.params.rich_message.html, /Ops.*Working/s)
  assert.equal(snapshot.sent.params.message_thread_id, 103)
  press(s, 'room-stop', snapshot, 103)
  await s.request('answerCallbackQuery', p => p.callback_query_id === 'room-stop' && p.text === 'Stopped.')
  await until(() => s.agentOf('ar1').cancelled)
  assert.notEqual(s.agentOf('a').cancelled, true)
  await s.request('editMessageText', p => p.message_id === snapshot.messageId)
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
  await s.request('sendRichMessage', p => p.message_thread_id === 1 && /Chief — Idle/.test(p.rich_message.html), after)
})
