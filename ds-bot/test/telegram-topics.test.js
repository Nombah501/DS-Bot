import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge, until } from './telegram-bridge.js'
import { setTimeout as delay } from 'node:timers/promises'

const team = () => ({
  version: 1, mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'everyone', admin: 'a', named: true, sessions: { a: 'ar1' }, log: [], seq: 0 } },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})
const topicsMe = { id: 7, username: 'fakebot', is_bot: true, has_topics_enabled: true }
const setup = async (t, access) => {
  const s = await startBridge(t, { seed: team(), getMe: topicsMe, pair: false })
  let next = 100
  s.replies.createForumTopic = () => ({ ok: true, result: { message_thread_id: ++next } })
  s.message('hello')
  await s.request('sendMessage', p => /connection request/.test(p.text))
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '9', allow: true, ...(access === undefined ? {} : { access }) })
  return s
}

test('S1: pairing in topic mode creates a Topic for every accessible Bot and group', async t => {
  const s = await setup(t)
  for (const name of ['Chief', 'Writer', 'Ops']) {
    const created = await s.request('createForumTopic', p => p.name === name)
    assert.equal(created.params.chat_id, '5')
  }
})

test('S1: Bot steps, Drafts and Cards stay in their own Topic', async t => {
  const s = await setup(t)
  s.assistantStream({ type: 'start', attemptId: 'writer', revision: 1, turn: 1, step: 1 }, 'b')
  s.assistantStream({ type: 'chunk', attemptId: 'writer', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'Writer draft' } }, 'b')
  const draft = await s.request('sendRichMessageDraft')
  assert.equal(draft.params.message_thread_id, 102)
  s.step('Writer final', { turn: 1, step: 1 }, 'b')
  const step = await s.request('sendRichMessage', p => /Writer final/.test(p.rich_message.html))
  assert.equal(step.params.message_thread_id, 102)
  await s.question({ question: 'Writer choice?', options: [{ label: 'Yes' }] }, 'b')
  const card = await s.request('sendRichMessage', p => /Writer choice/.test(p.rich_message.html))
  assert.equal(card.params.message_thread_id, 102)
  assert.equal(s.calls.some(call => call.method === 'sendRichMessage' && /Writer/.test(call.params.rich_message.html) && call.params.message_thread_id !== 102), false)
})

test('S1: messages, numeric replies and button answers resolve the originating Topic', async t => {
  const s = await setup(t)
  s.message('Write this', { message_thread_id: 102 })
  const prompt = await until(() => s.prompts.find(p => p.content?.[0]?.text === 'Write this'))
  assert.equal(prompt.sessionId, 'b')
  await s.question({ question: 'Chief choice?', options: [{ label: 'Chief yes' }] })
  await s.question({ question: 'Writer choice?', options: [{ label: 'Writer yes' }] }, 'b')
  await s.request('sendRichMessage', p => /Writer choice/.test(p.rich_message.html))
  s.message('1', { message_thread_id: 101 })
  await until(() => s.agentOf('a').followed)
  assert.equal(s.agentOf('b').followed, undefined)
  const writer = await s.request('sendRichMessage', p => /Writer choice/.test(p.rich_message.html))
  const data = /data="([^"]+)"/.exec(writer.params.rich_message.html)[1]
  s.pushUpdate({ callback_query: { id: 'writer-answer', from: { id: 9, first_name: 'Ann' }, message: { message_id: 20, message_thread_id: 102, chat: { id: 5, type: 'private' } }, data } })
  await until(() => s.agentOf('b').followed)
  await s.request('editMessageText', p => /Writer yes/.test(p.rich_message?.html ?? ''))
})

test('S1: /stop and Draft Stop in a group Topic stop only that DS Bot group', async t => {
  const s = await setup(t)
  s.rt.liveOf('ar1').turn = 1
  s.rt.liveOf('a').turn = 1
  s.message('/stop', { message_thread_id: 103 })
  await until(() => s.agentOf('ar1').cancelled)
  assert.notEqual(s.agentOf('a').cancelled, true)
  const stopped = await s.request('sendMessage', p => p.text === 'Stopped.')
  assert.equal(stopped.params.message_thread_id, 103)
  s.rt.liveOf('b').turn = 1
  s.assistantStream({ type: 'start', attemptId: 'writer-stop', revision: 1, turn: 1, step: 1 }, 'b')
  s.assistantStream({ type: 'chunk', attemptId: 'writer-stop', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'Writer active' } }, 'b')
  const draft = await s.request('sendRichMessageDraft')
  s.pushUpdate({ stopped_message_generation: { chat: { id: 5, type: 'private' }, message_thread_id: 102, draft_id: draft.params.draft_id } })
  await until(() => s.agentOf('b').cancelled)
  assert.notEqual(s.agentOf('a').cancelled, true)
})

test('S1: Access lists are chosen at pairing and narrowed in connection settings', async t => {
  const s = await setup(t, { botIds: ['b'], roomIds: [] })
  assert.deepEqual(s.calls.filter(call => call.method === 'createForumTopic').map(call => call.params.name), ['Writer'])
  s.message('Not for Chief')
  await s.request('sendMessage', p => /not on your Access list/.test(p.text))
  assert.equal(s.prompts.length, 0)
  s.message('For Writer', { message_thread_id: 101 })
  const prompt = await until(() => s.prompts.find(p => p.content?.[0]?.text === 'For Writer'))
  assert.equal(prompt.sessionId, 'b')
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: ['a'], roomIds: ['r1'] } })
  await s.request('createForumTopic', p => p.name === 'Chief')
  await s.request('createForumTopic', p => p.name === 'Ops')
  const after = s.calls.length
  s.message('Forbidden Topic', { message_thread_id: 101, from: { id: 9, first_name: 'Ann', language_code: 'ru' } })
  const denied = await s.request('sendMessage', p => /не входят в ваш список доступа/.test(p.text), after)
  assert.equal(denied.params.message_thread_id, 101)
  s.step('Hidden Writer output', {}, 'b')
  s.step('Visible Chief output')
  await s.request('sendRichMessage', p => /Visible Chief/.test(p.rich_message.html), after)
  assert.equal(s.calls.slice(after).some(call => call.method === 'sendRichMessage' && /Hidden Writer/.test(call.params.rich_message.html)), false)
  assert.equal(s.prompts.some(p => p.content?.[0]?.text === 'Forbidden Topic'), false)
})

test('S1: /status in a Topic reports that target, not the Default Bot', async t => {
  const s = await setup(t)
  s.rt.liveOf('b').turn = 1
  s.message('/status', { message_thread_id: 102 })
  const status = await s.request('sendWidget', p => JSON.parse(p.chat_data).name === 'Writer')
  assert.equal(status.params.message_thread_id, 102)
  assert.equal(JSON.parse(status.params.chat_data).state, 'Working')
  assert.equal(s.prompts.length, 0)
})

test('S1: an existing connection keeps its Default Bot and migrates paired people to all', async t => {
  const seed = team()
  seed.im = { connections: { im_legacy: {
    id: 'im_legacy', platform: 'telegram', botId: 'b', account: { id: '7', name: '@fakebot' },
    settings: { token: 'S1-FAKE-TOKEN' }, secrets: {}, enabled: true,
    paired: [{ id: '5', name: 'Ann', at: 1 }], requests: [],
    chats: { 5: { kind: 'direct', title: 'Ann', at: 1 } }, createdAt: 1,
  } } }
  const s = await startBridge(t, { seed, pair: false, existingConnectionId: 'im_legacy' })
  assert.equal(s.rt.imView().connections[0].paired[0].access, 'all')
  s.message('Legacy Default Bot', { from: { id: 5, first_name: 'Ann' } })
  const prompt = await until(() => s.prompts.find(p => p.content?.[0]?.text === 'Legacy Default Bot'))
  assert.equal(prompt.sessionId, 'b')
  s.step('Legacy Writer step', {}, 'b')
  const sent = await s.request('sendRichMessage', p => /Legacy Writer/.test(p.rich_message.html))
  assert.equal(sent.params.message_thread_id, undefined)
  assert.equal(s.calls.some(call => call.method === 'createForumTopic'), false)
})

test('S1: without topic mode, new connections use the Default Bot and enforce Access lists', async t => {
  const s = await startBridge(t, { seed: team() })
  const afterUpdate = s.calls.length
  await s.rt.imEndpoint('im-update', { id: s.connection.id, botId: 'b' })
  await s.request('getUpdates', () => true, afterUpdate)
  s.message('Default Writer')
  const prompt = await until(() => s.prompts.find(p => p.content?.[0]?.text === 'Default Writer'))
  assert.equal(prompt.sessionId, 'b')
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: ['a'], roomIds: [] } })
  s.message('/stop')
  await s.request('sendMessage', p => /not on your Access list/.test(p.text))
  assert.notEqual(s.agentOf('b').cancelled, true)
  assert.equal(s.calls.some(call => call.method === 'createForumTopic'), false)
})

test('S1: invalid Access lists do not discard pairing requests or alter access', async t => {
  const s = await startBridge(t, { seed: team(), getMe: topicsMe, pair: false })
  s.message('hello')
  await s.request('sendMessage', p => /connection request/.test(p.text))
  await assert.rejects(s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '9', allow: true, access: { botIds: ['missing'], roomIds: [] } }), /Access list/)
  assert.equal(s.rt.imView().connections[0].requests.length, 1)
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '9', allow: true, access: { botIds: [], roomIds: [] } })
  await assert.rejects(s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: 'all', roomIds: [] } }), /Access list/)
  s.message('Still denied')
  await s.request('sendMessage', p => /not on your Access list/.test(p.text))
  assert.equal(s.prompts.length, 0)
})

test('S1: narrowing access prevents further Draft previews and old Card answers', async t => {
  const s = await setup(t)
  await s.question({ question: 'Revoke Writer?', options: [{ label: 'Yes' }] }, 'b')
  const card = await s.request('sendRichMessage', p => /Revoke Writer/.test(p.rich_message.html))
  const data = /data="([^"]+)"/.exec(card.params.rich_message.html)[1]
  s.assistantStream({ type: 'start', attemptId: 'revoke', revision: 1, turn: 1, step: 1 }, 'b')
  s.assistantStream({ type: 'chunk', attemptId: 'revoke', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'Before revoke' } }, 'b')
  await s.request('sendRichMessageDraft')
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: ['a'], roomIds: [] } })
  const after = s.calls.length
  s.assistantStream({ type: 'chunk', attemptId: 'revoke', revision: 3, index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: ' forbidden' } }, 'b')
  s.pushUpdate({ callback_query: { id: 'revoked', from: { id: 9, first_name: 'Ann' }, message: { message_id: 20, message_thread_id: 102, chat: { id: 5, type: 'private' } }, data } })
  await s.request('sendMessage', p => /not on your Access list/.test(p.text), after)
  await delay(1100)
  assert.equal(s.calls.slice(after).some(call => call.method === 'sendRichMessageDraft'), false)
  assert.equal(s.agentOf('b').followed, undefined)
})

test('S1: multi-select toggles and submission remain in their Topic after integration', async t => {
  const s = await setup(t)
  await s.question({ question: 'Topic picks?', multiSelect: true, options: [{ label: 'First' }, { label: 'Second' }] }, 'b')
  const card = await s.request('sendRichMessage', p => /Topic picks/.test(p.rich_message.html))
  assert.equal(card.params.message_thread_id, 102)
  const data = [...card.params.rich_message.html.matchAll(/data="([^"]+)"/g)].map(match => match[1])
  const callback = (id, value) => s.pushUpdate({ callback_query: { id, from: { id: 9, first_name: 'Ann' }, message: { message_id: 20, message_thread_id: 102, chat: { id: 5, type: 'private' } }, data: value } })
  callback('toggle-topic', data[0])
  await s.request('editMessageText', p => /☑ First/.test(p.rich_message?.html ?? ''))
  callback('submit-topic', data.at(-1))
  await until(() => s.agentOf('b').followed)
  assert.equal(s.agentOf('a').followed, undefined)
})
