import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge, until } from './telegram-bridge.js'

const setup = async (t, { forum = false, target = { botId: 'a' } } = {}) => {
  const seed = {
    version: 1, mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', sessionId: 'b', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a'], mode: 'everyone', admin: 'a', named: true, sessions: { a: 'ar1' }, log: [], seq: 0 } },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
    im: { connections: { im_status: {
      id: 'im_status', platform: 'telegram', botId: 'a', account: { id: '7', name: '@fakebot' },
      settings: { token: 'S1-FAKE-TOKEN' }, secrets: {}, enabled: true,
      paired: [
        { id: '9', name: 'Ann', access: 'all', at: 1 },
        { id: '10', name: 'Denied', access: { botIds: [], roomIds: [] }, at: 1 },
        { id: '11', name: 'Other person', access: 'all', at: 1 },
      ], requests: [],
      chats: { '-20': { kind: 'group', title: 'Team', at: 1, ...(forum ? { isForum: true, topics: { 101: { target, name: 'Work', at: 1 } } } : { target }) } },
      createdAt: 1,
    } } },
  }
  const s = await startBridge(t, { seed, pair: false, existingConnectionId: 'im_status' })
  const chat = { id: -20, type: 'supergroup', title: 'Team', ...(forum ? { is_forum: true } : {}) }
  const thread = forum ? { message_thread_id: 101 } : {}
  let messageId = 700
  s.replies.sendRichMessage = () => ({ ok: true, result: { message_id: ++messageId } })
  const status = async (language = 'en') => {
    const after = s.calls.length
    s.message('/status@fakebot', { chat, ...thread, from: { id: 9, language_code: language } })
    const sent = await s.request('sendRichMessage', p => p.chat_id === '-20', after)
    const data = sent.params.rich_message.html.match(/type="callback_data" data="([^"]+)"/)?.[1]
    return { sent, data, messageId }
  }
  const press = (id, snapshot, { from = { id: 11, language_code: 'en' }, message = {}, data = snapshot.data } = {}) => {
    s.pushUpdate({ callback_query: { id, from, data, message: { message_id: snapshot.messageId, chat, ...thread, ...message } } })
  }
  return { s, status, press }
}

for (const forum of [false, true]) {
  test(`S1: ${forum ? 'forum Topic' : 'group'} status Stop cancels only its Bot once and removes the button`, async t => {
    const { s, status, press } = await setup(t, { forum, target: { botId: 'b' } })
    s.sessionEvent('turn/start', { turn: 1 }, 'a')
    s.sessionEvent('turn/start', { turn: 1 }, 'b')
    const snapshot = await status('ru-RU')
    assert.match(snapshot.sent.params.rich_message.html, /Остановить/)
    assert.ok(Buffer.byteLength(snapshot.data) <= 64)
    assert.equal(snapshot.sent.params.message_thread_id, forum ? 101 : undefined)
    let stops = 0
    const stop = s.rt.stopChat
    s.rt.stopChat = async botId => { stops++; assert.equal(botId, 'b'); return stop(botId) }
    press('stop', snapshot, { from: { id: 11, language_code: 'ru' } })
    await s.request('answerCallbackQuery', p => p.callback_query_id === 'stop' && p.text === 'Остановлено.')
    await until(() => s.agentOf('b').cancelled)
    assert.notEqual(s.agentOf('a').cancelled, true)
    const edited = await s.request('editMessageText', p => p.message_id === snapshot.messageId)
    assert.doesNotMatch(edited.params.rich_message.html, /type="callback_data"/)
    assert.equal(s.calls.some(c => c.method === 'sendMessage' && c.params.text === 'Остановлено.'), false)
    press('again', snapshot, { from: { id: 11, language_code: 'ru' } })
    await s.request('answerCallbackQuery', p => p.callback_query_id === 'again' && p.text === 'Сейчас ничего не выполняется.')
    assert.equal(s.calls.some(c => c.method === 'sendMessage' && c.params.text === 'Сейчас ничего не выполняется.'), false)
    assert.equal(stops, 1)
  })
}

for (const forum of [false, true]) {
  test(`S1: ${forum ? 'forum Topic' : 'group'} status Stop cancels room work without stopping the Bot own chat`, async t => {
    const { s, status, press } = await setup(t, { forum, target: { roomId: 'r1' } })
    s.rt.liveOf('ar1').turn = 1
    s.rt.liveOf('a').turn = 1
    const snapshot = await status()
    assert.match(snapshot.sent.params.rich_message.html, />Stop<\/tg-button>/)
    let stops = 0
    const stop = s.rt.stopRoomWork
    s.rt.stopRoomWork = async roomId => { stops++; assert.equal(roomId, 'r1'); return stop(roomId) }
    press('room-stop', snapshot)
    await s.request('answerCallbackQuery', p => p.callback_query_id === 'room-stop' && p.text === 'Stopped.')
    await until(() => s.agentOf('ar1').cancelled)
    await s.request('editMessageText', p => p.message_id === snapshot.messageId)
    assert.notEqual(s.agentOf('a').cancelled, true)
    press('room-again', snapshot)
    await s.request('answerCallbackQuery', p => p.callback_query_id === 'room-again' && p.text === 'Nothing is running.')
    assert.equal(s.calls.some(c => c.method === 'sendMessage' && /^(Stopped\.|Nothing is running\.)$/.test(c.params.text)), false)
    assert.equal(stops, 1)
  })
}

test('S1: unpaired, inaccessible, copied and rebound status Stop buttons cannot reach DSH', async t => {
  const { s, status, press } = await setup(t, { forum: true, target: { botId: 'b' } })
  s.sessionEvent('turn/start', { turn: 1 }, 'b')
  const snapshot = await status()
  let stops = 0
  s.rt.stopChat = async () => { stops++; return true }
  for (const [id, options, reply] of [
    ['unpaired', { from: { id: 99 } }, 'This Bot or group is not on your Access list.'],
    ['denied', { from: { id: 10 } }, 'This Bot or group is not on your Access list.'],
    ['wrong-topic', { message: { message_thread_id: 102 } }, 'Nothing is running.'],
    ['wrong-message', { message: { message_id: snapshot.messageId + 1 } }, 'Nothing is running.'],
    ['wrong-chat', { message: { chat: { id: -21, type: 'supergroup' } } }, 'Nothing is running.'],
    ['wrong-action', { data: snapshot.data.replace(/:stop$/, ':other') }, 'Nothing is running.'],
  ]) {
    const after = s.calls.length
    press(id, snapshot, options)
    await s.request('answerCallbackQuery', p => p.callback_query_id === id && p.text === reply, after)
    assert.equal(s.calls.slice(after).some(c => c.method === 'sendMessage'), false)
    assert.equal(stops, 0)
  }
  s.replies.getChatMember = { ok: true, result: { status: 'administrator' } }
  const binding = s.calls.length
  s.message('/bind', { chat: { id: -20, type: 'supergroup', is_forum: true }, message_thread_id: 101 })
  const picker = await s.request('sendRichMessage', p => /Choose a Bot/.test(p.rich_message.html), binding)
  const data = picker.params.rich_message.html.match(/data="([^"]+)"[^>]*>Chief</)[1]
  press('bind-chief', { data, messageId: 702 }, { from: { id: 9 } })
  await s.request('editMessageText', p => /Topic bound to Chief/.test(p.rich_message?.html), binding)
  const after = s.calls.length
  press('rebound', snapshot)
  await s.request('answerCallbackQuery', p => p.callback_query_id === 'rebound' && /Access list|Nothing is running/.test(p.text), after)
  assert.equal(s.calls.slice(after).some(c => c.method === 'sendMessage'), false)
  assert.equal(stops, 0)
})

test('S1: an idle group or forum status has no Stop control', async t => {
  for (const forum of [false, true]) {
    const { s, status } = await setup(t, { forum })
    const snapshot = await status()
    assert.equal(snapshot.data, undefined)
    assert.doesNotMatch(snapshot.sent.params.rich_message.html, /<tg-button/)
    assert.equal(s.calls.some(call => call.method === 'sendWidget'), false)
  }
})

test('S1: status Stop uses Chinese labels and clears a naturally finished snapshot without cancellation', async t => {
  const { s, status, press } = await setup(t)
  s.rt.uiLanguage = () => 'Chinese'
  s.sessionEvent('turn/start', { turn: 1 })
  const snapshot = await status()
  assert.match(snapshot.sent.params.rich_message.html, />停止<\/tg-button>/)
  s.sessionEvent('turn/end', { turn: 1 })
  let stops = 0
  s.rt.stopChat = async () => { stops++; return true }
  press('finished', snapshot)
  await s.request('answerCallbackQuery', p => p.callback_query_id === 'finished' && p.text === '现在没有在做的活。')
  assert.equal(s.calls.some(c => c.method === 'sendMessage' && c.params.text === '现在没有在做的活。'), false)
  assert.equal(stops, 0)
})
