import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startBridge, until } from './telegram-bridge.js'

const forum = { id: -60, type: 'supergroup', title: 'Forum', is_forum: true }
const setup = async (t, seed) => {
  const s = await startBridge(t, { seed, pair: false, getMe: { id: 7, username: 'fakebot', is_bot: true, has_topics_enabled: true } })
  s.replies.createForumTopic = { ok: true, result: { message_thread_id: 101 } }
  s.message('hello')
  await s.request('sendMessage', p => /connection request/.test(p.text))
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '9', allow: true })
  s.replies.getChatMember = { ok: true, result: { status: 'administrator' } }
  s.message('/bind', { chat: forum, message_thread_id: 40 })
  const card = await s.request('sendRichMessage', p => /Choose a Bot/.test(p.rich_message.html))
  s.pushUpdate({ callback_query: { id: 'bind', from: { id: 9, first_name: 'Ann' }, message: { message_id: 20, message_thread_id: 40, chat: forum }, data: /data="([^"]+)"/.exec(card.params.rich_message.html)[1] } })
  await s.request('editMessageText', p => /Topic bound/.test(p.rich_message?.html ?? ''))
  return s
}
const begin = async (s, extra, turn = 1) => {
  const text = `Start turn ${turn}`
  s.message(text, extra)
  const prompt = await until(() => s.prompts.find(p => p.content?.[0]?.text === text))
  s.sessionEvent('turn/start', { turn })
  s.sessionEvent('user/message', { source: { kind: 'user', rpcId: prompt.requestId } })
}
const outputs = (s, after, text) => s.calls.slice(after).filter(c => c.method === 'sendRichMessage' && c.params.rich_message.html.includes(text)).map(c => [c.params.chat_id, c.params.message_thread_id])

test('S1: forum-origin Steps go only to the exact forum Topic, including after restart', async t => {
  const s = await setup(t)
  await begin(s, { chat: forum, message_thread_id: 40 })
  await s.restart()
  const after = s.calls.length
  s.step('Forum-only step')
  await s.request('sendRichMessage', p => p.rich_message.html.includes('Forum-only step'), after)
  await delay(80)
  assert.deepEqual(outputs(s, after, 'Forum-only step'), [['-60', 40]])
})

const stream = (s, attemptId = 'draft') => {
  s.assistantStream({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })
  s.assistantStream({ type: 'chunk', attemptId, revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'Origin draft' } })
}
const approve = (t, s, reason = 'Origin approval') => {
  const controller = new AbortController()
  t.after(() => controller.abort())
  return s.approval({ agent: s.agentOf('a'), toolName: 'bash', reason, signal: controller.signal })
}

test('S1: private-origin Steps and Drafts never reach the forum', async t => {
  const s = await setup(t)
  await begin(s, { message_thread_id: 101 })
  const after = s.calls.length
  stream(s)
  const draft = await s.request('sendRichMessageDraft', () => true, after)
  assert.equal(draft.params.chat_id, 5)
  assert.equal(draft.params.message_thread_id, 101)
  s.step('Private-only step')
  await s.request('sendRichMessage', p => p.rich_message.html.includes('Private-only step'), after)
  await delay(80)
  assert.deepEqual(outputs(s, after, 'Private-only step'), [['5', 101]])
})

for (const place of ['forum', 'private']) test(`S1: ${place}-origin questions and approvals stay at their origin`, async t => {
  const s = await setup(t)
  await begin(s, place === 'forum' ? { chat: forum, message_thread_id: 40 } : { message_thread_id: 101 })
  const after = s.calls.length
  await s.question({ question: 'Origin question?', options: [{ label: 'Yes' }] })
  void approve(t, s)
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Origin approval'), after)
  await s.request('sendRichMessage', p => p.rich_message.html.includes('Origin question'), after)
  await delay(80)
  const expected = place === 'forum' ? [['-60', 40]] : [['5', 101]]
  assert.deepEqual(outputs(s, after, 'Origin question'), expected)
  assert.deepEqual(outputs(s, after, 'Origin approval'), expected)
  assert.deepEqual(sent.params.ephemeral_message_parameters, place === 'forum' ? { receiver_user_id: 9 } : undefined)
})

test('S1: autonomous turns default to all output in accessible private Topics only', async t => {
  const s = await setup(t)
  assert.equal(s.rt.imView().connections[0].nonTelegramTurns, 'all')
  const after = s.calls.length
  s.sessionEvent('turn/start', { turn: 1 })
  s.step('Autonomous step')
  stream(s)
  await s.request('sendRichMessage', p => p.rich_message.html.includes('Autonomous step'), after)
  await s.request('sendRichMessageDraft', () => true, after)
  await delay(80)
  assert.deepEqual(outputs(s, after, 'Autonomous step'), [['5', 101]])
  assert.equal(s.calls.slice(after).some(c => c.method === 'sendRichMessageDraft' && c.params.chat_id !== 5), false)
})

for (const mode of ['cards', 'none']) test(`S1: autonomous ${mode} setting filters Steps, Drafts, Cards and typing`, async t => {
  const s = await setup(t)
  await s.rt.imEndpoint('im-update', { id: s.connection.id, nonTelegramTurns: mode })
  await s.restart()
  assert.equal(s.rt.imView().connections[0].nonTelegramTurns, mode)
  const after = s.calls.length
  s.sessionEvent('turn/start', { turn: 1 })
  s.rt.liveOf('a').turn = 1
  s.step('Filtered step')
  stream(s)
  void approve(t, s)
  await s.question({ question: 'Filtered question?', options: [{ label: 'Yes' }] })
  if (mode === 'cards') await s.request('sendRichMessage', p => p.rich_message.html.includes('Origin approval'), after)
  await delay(4200)
  assert.deepEqual(outputs(s, after, 'Filtered step'), [])
  assert.equal(s.calls.slice(after).some(c => ['sendRichMessageDraft', 'sendChatAction'].includes(c.method)), false)
  assert.deepEqual(outputs(s, after, 'Origin approval'), mode === 'cards' ? [['5', 101]] : [])
  assert.deepEqual(outputs(s, after, 'Filtered question'), mode === 'cards' ? [['5', 101]] : [])
})

test('S1: rebinding the origin mid-turn falls back to accessible private destinations', async t => {
  const s = await setup(t)
  await begin(s, { chat: forum, message_thread_id: 40 })
  // Removing the physical chat is the public settings operation for unbinding it.
  await s.rt.imEndpoint('im-chat', { id: s.connection.id, chatKey: '-60', remove: true })
  const after = s.calls.length
  s.step('After unbinding')
  await s.request('sendRichMessage', p => /After unbinding/.test(p.rich_message.html), after)
  await delay(80)
  assert.deepEqual(outputs(s, after, 'After unbinding'), [['5', 101]])
})

for (const place of ['forum', 'private']) test(`S1: typing follows the ${place} turn origin even with autonomous output disabled`, async t => {
  const s = await setup(t)
  await s.rt.imEndpoint('im-update', { id: s.connection.id, nonTelegramTurns: 'none' })
  await s.restart()
  await begin(s, place === 'forum' ? { chat: forum, message_thread_id: 40 } : { message_thread_id: 101 })
  s.rt.liveOf('a').turn = 1
  const after = s.calls.length
  await until(() => s.calls.slice(after).find(c => c.method === 'sendChatAction'), 6000)
  await delay(80)
  assert.deepEqual(s.calls.slice(after).filter(c => c.method === 'sendChatAction').map(c => [c.params.chat_id, c.params.message_thread_id]),
    place === 'forum' ? [['-60', 40]] : [['5', 101]])
})

test('S1: invalid autonomous settings leave the connection unchanged', async t => {
  const s = await setup(t)
  await assert.rejects(s.rt.imEndpoint('im-update', { id: s.connection.id, nonTelegramTurns: 'groups' }), /Choose all messages/)
  assert.equal(s.rt.imView().connections[0].nonTelegramTurns, 'all')
})

test('S1: a Bot origin stays on its connection, while autonomous work reaches each accessible private place', async t => {
  const seed = {
    version: 1, mainBotIds: ['a'], bots: { a: { id: 'a', name: 'Chief', sessionId: 'a', createdAt: 1 } },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
    im: { connections: { im_other: {
      id: 'im_other', platform: 'telegram', botId: 'a', enabled: false, settings: { token: 'S1-OTHER-FAKE-TOKEN' }, secrets: {},
      paired: [{ id: '10', name: 'Bob', access: 'all', at: 1 }], requests: [],
      chats: { 10: { kind: 'direct', personId: '10', topics: { 201: { target: { botId: 'a' }, name: 'Chief', at: 1 } } } },
      account: { id: '8', name: 'Other', hasTopicsEnabled: true }, createdAt: 1,
    } } },
  }
  const s = await setup(t, seed)
  await begin(s, { chat: forum, message_thread_id: 40 })
  await s.rt.imEndpoint('im-update', { id: 'im_other', enabled: true })
  const after = s.calls.length
  s.step('Connection-local step')
  await s.request('sendRichMessage', p => /Connection-local/.test(p.rich_message.html), after)
  await delay(80)
  assert.deepEqual(outputs(s, after, 'Connection-local step'), [['-60', 40]])
  s.sessionEvent('turn/start', { turn: 2 })
  s.step('Autonomous across connections')
  await s.request('sendRichMessage', p => p.chat_id === '10' && /Autonomous across/.test(p.rich_message.html), after)
  await s.request('sendRichMessage', p => p.chat_id === '5' && /Autonomous across/.test(p.rich_message.html), after)
  assert.deepEqual(outputs(s, after, 'Autonomous across connections').sort(), [['10', 201], ['5', 101]])
})

test('S1: revoked origin and new Draft chunks fall back without leaking to other group places', async t => {
  const s = await setup(t)
  await begin(s, { chat: forum, message_thread_id: 40 })
  stream(s)
  await s.rt.imEndpoint('im-chat', { id: s.connection.id, chatKey: '-60', remove: true })
  const after = s.calls.length
  s.assistantStream({ type: 'chunk', attemptId: 'draft', revision: 3, index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: ' after unbinding' } })
  const draft = await s.request('sendRichMessageDraft', () => true, after)
  assert.equal(draft.params.chat_id, 5)
  assert.equal(draft.params.message_thread_id, 101)
  assert.match(draft.params.rich_message.html, /after unbinding/)
})

for (const place of ['forum', 'private']) test(`S1: secret and view Cards follow the ${place} origin`, async t => {
  const s = await setup(t)
  await begin(s, place === 'forum' ? { chat: forum, message_thread_id: 40 } : { message_thread_id: 101 })
  const after = s.calls.length
  await s.rt.teamTools.find(tool => tool.name === 'request_secret').execute({ name: 'ORIGIN_KEY', purpose: 'Origin test' }, { agent: { id: 'a' }, callId: 'secret-origin', concludeTurn() {} })
  await s.rt.teamTools.find(tool => tool.name === 'show_view').execute({ title: 'Origin view', view: { type: 'options', id: 'pick', options: [{ label: 'Yes' }] }, wait: true }, { agent: { id: 'a' }, callId: 'view-origin', concludeTurn() {} })
  const secret = await s.request('sendMessage', p => /ORIGIN_KEY/.test(p.text), after)
  const view = await s.request('sendMessage', p => /Origin view/.test(p.text), after)
  await delay(80)
  for (const sent of [secret, view]) {
    assert.equal(sent.params.chat_id, place === 'forum' ? '-60' : '5')
    assert.equal(sent.params.message_thread_id, place === 'forum' ? 40 : 101)
  }
  assert.equal(s.calls.slice(after).filter(call => call.method === 'sendMessage' && /ORIGIN_KEY|Origin view/.test(call.params.text)).length, 2)
})
