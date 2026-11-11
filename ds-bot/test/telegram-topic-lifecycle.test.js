import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge } from './telegram-bridge.js'

const team = () => ({
  version: 1, mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'everyone', admin: 'a', named: true, sessions: {}, log: [], seq: 0 } },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})
const setup = async (t, languageCode) => {
  const s = await startBridge(t, { seed: team(), getMe: { id: 7, username: 'fakebot', is_bot: true, has_topics_enabled: true }, pair: false })
  s.ctx.sessionTitle = { rename: async () => {} }
  let next = 100
  s.replies.createForumTopic = () => ({ ok: true, result: { message_thread_id: ++next } })
  s.message('hello', { from: { id: 9, first_name: 'Ann', ...(languageCode === undefined ? {} : { language_code: languageCode }) } })
  await s.request('sendMessage', p => /connection request|Запрос на подключение/.test(p.text))
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '9', allow: true })
  return s
}

test('S1: renaming a Bot renames its existing Topic without creating another', async t => {
  const s = await setup(t)
  const after = s.calls.length
  await s.rt.updateBot('b', { name: 'Editor' })
  const renamed = await s.request('editForumTopic', p => p.name === 'Editor', after)
  assert.equal(renamed.params.chat_id, '5')
  assert.equal(renamed.params.message_thread_id, 102)
  assert.equal(s.calls.slice(after).some(call => call.method === 'createForumTopic'), false)
})

test('S1: deleting a Bot explains and closes its Topic while preserving history', async t => {
  const s = await setup(t)
  const after = s.calls.length
  await s.rt.deleteBot('b')
  const notice = await s.request('sendMessage', p => /Writer.*deleted/.test(p.text), after)
  assert.equal(notice.params.message_thread_id, 102)
  const closed = await s.request('closeForumTopic', p => p.message_thread_id === 102, after)
  assert.equal(closed.params.chat_id, '5')
  assert.equal(s.calls.slice(after).some(call => call.method === 'deleteForumTopic'), false)
})

test('S1: Access removal closes only that person’s Topic with a localized explanation', async t => {
  const s = await setup(t, 'ru')
  s.message('hello', { chat: { id: 6, type: 'private' }, from: { id: 10, first_name: 'Ben' } })
  await s.request('sendMessage', p => p.chat_id === '6' && /connection request/.test(p.text))
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '10', allow: true })
  const after = s.calls.length
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: ['a'], roomIds: ['r1'] } })
  const notice = await s.request('sendMessage', p => /Writer.*больше не входит в ваш список доступа/.test(p.text), after)
  assert.equal(notice.params.chat_id, '5')
  assert.equal(notice.params.message_thread_id, 102)
  await s.request('closeForumTopic', p => p.chat_id === '5' && p.message_thread_id === 102, after)
  s.step('Still for Ben', {}, 'b')
  const sent = await s.request('sendRichMessage', p => /Still for Ben/.test(p.rich_message.html), after)
  assert.equal(sent.params.chat_id, '6')
  assert.equal(sent.params.message_thread_id, 105)
  assert.equal(s.calls.slice(after).some(call => call.method === 'closeForumTopic' && call.params.chat_id === '6'), false)
  assert.equal(s.calls.slice(after).some(call => call.method === 'sendRichMessage' && call.params.chat_id === '5'), false)
})

test('S1: a newly created Bot gets a Topic automatically for all-access people', async t => {
  const s = await setup(t)
  s.ctx.sessionController.create = async () => ({ sessionId: 'c' })
  const after = s.calls.length
  await s.rt.createBot({ name: 'Tester', pickModel: true })
  const created = await s.request('createForumTopic', p => p.name === 'Tester', after)
  assert.equal(created.params.chat_id, '5')
  s.step('New Bot output', {}, 'c')
  const sent = await s.request('sendRichMessage', p => /New Bot output/.test(p.rich_message.html), after)
  assert.equal(sent.params.message_thread_id, 104)
})

test('S1: a deleted Topic is recreated and the failed Step reaches its replacement', async t => {
  const s = await setup(t)
  s.replies.sendRichMessage = params => params.message_thread_id === 102
    ? { ok: false, error_code: 400, description: 'Bad Request: message thread not found' }
    : { ok: true, result: { message_id: 500 } }
  const after = s.calls.length
  s.step('Recovered Writer output', {}, 'b')
  await s.request('createForumTopic', p => p.name === 'Writer', after)
  const sent = await s.request('sendRichMessage', p => p.message_thread_id === 104 && /Recovered Writer output/.test(p.rich_message.html), after)
  assert.equal(sent.params.chat_id, '5')
  s.step('Next Writer output', {}, 'b')
  await s.request('sendRichMessage', p => p.message_thread_id === 104 && /Next Writer output/.test(p.rich_message.html), after)
  assert.equal(s.calls.slice(after).filter(call => call.method === 'createForumTopic').length, 1)
})

test('S1: group Topics follow group renames and deletion too', async t => {
  const s = await setup(t)
  const after = s.calls.length
  await s.rt.updateRoom('r1', { name: 'Support' })
  await s.request('editForumTopic', p => p.message_thread_id === 103 && p.name === 'Support', after)
  await s.rt.deleteRoom('r1')
  await s.request('sendMessage', p => p.message_thread_id === 103 && /Support.*deleted/.test(p.text), after)
  await s.request('closeForumTopic', p => p.message_thread_id === 103, after)
})

test('S1: a Card sent to a deleted Topic can be answered in its replacement', async t => {
  const s = await setup(t)
  s.replies.sendRichMessage = params => params.message_thread_id === 102
    ? { ok: false, error_code: 400, description: 'Bad Request: MESSAGE_THREAD_INVALID' }
    : { ok: true, result: { message_id: 501 } }
  const after = s.calls.length
  await s.question({ question: 'Recovered choice?', options: [{ label: 'Yes' }] }, 'b')
  const sent = await s.request('sendRichMessage', p => p.message_thread_id === 104 && /Recovered choice/.test(p.rich_message.html), after)
  const data = /data="([^"]+)"/.exec(sent.params.rich_message.html)[1]
  s.pushUpdate({ callback_query: { id: 'recovered', from: { id: 9, first_name: 'Ann' }, message: { message_id: 501, chat: { id: 5, type: 'private' }, message_thread_id: 104 }, data } })
  await s.request('editMessageText', p => p.message_id === 501 && /type="disabled"/.test(p.rich_message?.html ?? ''), after)
})

test('S1: a Draft in a deleted Topic recovers and Stop keeps its new Topic identity', async t => {
  const s = await setup(t)
  s.replies.sendRichMessageDraft = params => params.message_thread_id === 102
    ? { ok: false, error_code: 400, description: 'Bad Request: message thread not found' }
    : { ok: true, result: true }
  const after = s.calls.length
  s.assistantStream({ type: 'start', attemptId: 'recover-draft', revision: 1, turn: 1, step: 1 }, 'b')
  s.assistantStream({ type: 'chunk', attemptId: 'recover-draft', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'Recovered Draft' } }, 'b')
  const draft = await s.request('sendRichMessageDraft', p => p.message_thread_id === 104, after)
  s.pushUpdate({ stopped_message_generation: { chat: { id: 5, type: 'private' }, message_thread_id: 104, draft_id: draft.params.draft_id } })
  await s.request('sendMessage', p => p.message_thread_id === 104 && /Nothing is running/.test(p.text), after)
})

test('S1: unrelated permanent send errors never create replacement Topics', async t => {
  const s = await setup(t)
  s.replies.sendRichMessage = params => /Invalid rich output/.test(params.rich_message.html)
    ? { ok: false, error_code: 400, description: 'Bad Request: invalid rich message' }
    : { ok: true, result: { message_id: 502 } }
  const after = s.calls.length
  s.step('Invalid rich output', {}, 'b')
  await s.request('sendRichMessage', p => /Invalid rich output/.test(p.rich_message.html), after)
  // A subsequent response on this same queue is the observable completion barrier.
  s.message('/stop', { message_thread_id: 102 })
  await s.request('sendMessage', p => p.message_thread_id === 102 && /Nothing is running/.test(p.text), after)
  assert.equal(s.calls.slice(after).some(call => call.method === 'createForumTopic'), false)
})

test('S1: a Status panel sent to a deleted Topic recovers, pins and stops its original Bot', async t => {
  const s = await setup(t)
  s.replies.sendWidget = params => params.message_thread_id === 102
    ? { ok: false, error_code: 400, description: 'Bad Request: message thread not found' }
    : { ok: true, result: { message_id: 601 } }
  const after = s.calls.length
  s.message('/status', { message_thread_id: 102 })
  const widget = await s.request('sendWidget', p => p.message_thread_id === 104, after)
  assert.equal(JSON.parse(widget.params.chat_data).name, 'Writer')
  await s.request('pinChatMessage', p => p.message_id === 601, after)
  s.pushUpdate({ widget_query: { id: 'recovered-panel', from: { id: 9, first_name: 'Ann' }, chat: { id: 5, type: 'private' }, message_id: 601, type: { type: 'data' }, data: 'stop' } })
  await s.request('sendMessage', p => p.message_thread_id === 104 && /Nothing is running/.test(p.text), after)
})

test('S1: an existing Status panel is replaced after Step delivery recovers its deleted Topic', async t => {
  const s = await setup(t)
  s.message('/status', { message_thread_id: 102 })
  await s.request('pinChatMessage')
  s.replies.sendRichMessage = params => params.message_thread_id === 102
    ? { ok: false, error_code: 400, description: 'Bad Request: message thread not found' }
    : { ok: true, result: { message_id: 602 } }
  const after = s.calls.length
  s.step('Recover panel Topic', {}, 'b')
  await s.request('sendRichMessage', p => p.message_thread_id === 104, after)
  const widget = await s.request('sendWidget', p => p.message_thread_id === 104, after)
  assert.equal(JSON.parse(widget.params.chat_data).name, 'Writer')
  const pin = await s.request('pinChatMessage', () => true, after)
  s.pushUpdate({ widget_query: { id: 'moved-panel', from: { id: 9 }, chat: { id: 5, type: 'private' }, message_id: pin.params.message_id, type: { type: 'data' }, data: 'stop' } })
  await s.request('sendMessage', p => p.message_thread_id === 104 && /Nothing is running/.test(p.text), after)
})

test('S1: private Topic lifecycle leaves admin-managed forum bindings intact', async t => {
  const s = await setup(t)
  const forum = { id: -60, type: 'supergroup', title: 'Forum', is_forum: true }
  s.replies.getChatMember = { ok: true, result: { status: 'administrator' } }
  s.message('/bind', { chat: forum, message_thread_id: 40 })
  const card = await s.request('sendRichMessage', p => p.chat_id === '-60' && /Choose a Bot/.test(p.rich_message.html))
  const data = /data="([^"]+)"[^>]*>Writer</.exec(card.params.rich_message.html)[1]
  s.pushUpdate({ callback_query: { id: 'bind-lifecycle', from: { id: 9 }, data, message: { message_id: 900, chat: forum, message_thread_id: 40 } } })
  await s.request('editMessageText', p => /type="disabled"/.test(p.rich_message?.html ?? ''))
  const after = s.calls.length
  await s.rt.updateBot('b', { name: 'Editor' })
  await s.request('editForumTopic', p => p.message_thread_id === 102 && p.name === 'Editor', after)
  s.message('Work in forum', { chat: forum, message_thread_id: 40 })
  const prompt = await until(() => s.prompts.find(p => p.content?.[0]?.text === 'Work in forum'))
  s.sessionEvent('turn/start', { turn: 1 }, 'b')
  s.sessionEvent('user/message', { source: { kind: 'user', rpcId: prompt.requestId } }, 'b')
  s.step('Bound after rename', {}, 'b')
  await s.request('sendRichMessage', p => p.chat_id === '-60' && p.message_thread_id === 40 && /Bound after rename/.test(p.rich_message.html), after)
  s.replies.sendRichMessage = params => params.chat_id === '-60'
    ? { ok: false, error_code: 400, description: 'Bad Request: message thread not found' }
    : { ok: true, result: { message_id: 603 } }
  s.step('Missing forum Topic', {}, 'b')
  await s.request('sendRichMessage', p => p.chat_id === '-60' && /Missing forum Topic/.test(p.rich_message.html), after)
  s.message('/stop', { chat: forum, message_thread_id: 40 })
  await s.request('sendMessage', p => p.chat_id === '-60' && /Nothing is running/.test(p.text), after)
  await s.rt.deleteBot('b')
  await s.request('closeForumTopic', p => p.chat_id === '5' && p.message_thread_id === 102, after)
  assert.equal(s.calls.slice(after).some(call => ['createForumTopic', 'editForumTopic', 'closeForumTopic'].includes(call.method) && call.params.chat_id === '-60'), false)
})
