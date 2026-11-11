import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge, until } from './telegram-bridge.js'

const forum = { id: -60, type: 'supergroup', title: 'Forum', is_forum: true }
const team = () => ({
  version: 1, mainBotIds: ['a'],
  bots: { a: { id: 'a', name: 'Chief', sessionId: 'a', createdAt: 1 }, b: { id: 'b', name: 'Writer', sessionId: 'b', createdAt: 2 } },
  rooms: { r1: { id: 'r1', sessionId: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'everyone', admin: 'a', named: true, sessions: { a: 'ar1' }, log: [], seq: 0 } },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})
const press = (s, data, threadId = 40, from = { id: 9, first_name: 'Ann', language_code: 'en' }) => s.pushUpdate({ callback_query: {
  id: `bind-${s.calls.length}`, from, data,
  message: { message_id: 900, chat: forum, message_thread_id: threadId },
} })
const choice = (sent, label) => new RegExp(`data="([^"]+)"[^>]*>${label}<`).exec(sent.params.rich_message.html)[1]
const bind = async (s, label, threadId = 40) => {
  const after = s.calls.length
  s.message('/bind', { chat: forum, message_thread_id: threadId })
  const sent = await s.request('sendRichMessage', p => p.chat_id === '-60' && p.message_thread_id === threadId && p.rich_message.html.includes('Choose a Bot'), after)
  press(s, choice(sent, label), threadId)
  await s.request('editMessageText', p => p.rich_message?.html.includes('type="disabled"') && p.rich_message.html.includes(label), after)
  return sent
}

test('S1: a paired forum admin binds accessible Bots and groups and routing survives restart', async t => {
  const s = await startBridge(t, { seed: team() })
  s.replies.getChatMember = { ok: true, result: { status: 'administrator' } }
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: ['b'], roomIds: ['r1'] } })
  const card = await bind(s, 'Writer')
  assert.doesNotMatch(card.params.rich_message.html, />Chief</)
  assert.match(card.params.rich_message.html, />Ops</)
  assert.ok([...card.params.rich_message.html.matchAll(/data="([^"]+)"/g)].every(match => Buffer.byteLength(match[1]) <= 64))
  const check = await s.request('getChatMember')
  assert.deepEqual(check.params, { chat_id: '-60', user_id: 9 })
  s.message('Write the report', { chat: forum, message_thread_id: 40 })
  assert.equal((await until(() => s.prompts.find(p => p.content?.[0]?.text === 'Write the report'))).sessionId, 'b')
  s.step('Writer forum output', {}, 'b')
  const step = await s.request('sendRichMessage', p => p.chat_id === '-60' && /Writer forum output/.test(p.rich_message.html))
  assert.equal(step.params.message_thread_id, 40)
  await bind(s, 'Ops', 50)
  s.message('Coordinate work', { chat: forum, message_thread_id: 50 })
  assert.equal((await until(() => s.prompts.find(p => p.content?.[0]?.text === 'Coordinate work'))).sessionId, 'r1')
  await s.restart()
  s.message('After restart', { chat: forum, message_thread_id: 40 })
  assert.equal((await until(() => s.prompts.find(p => p.content?.[0]?.text === 'After restart'))).sessionId, 'b')
})

test('S1: General uses Default Bot with either Telegram General address and never absorbs unknown Topics', async t => {
  const s = await startBridge(t)
  for (const thread of [undefined, 1]) {
    const content = `General ${thread}`
    s.message(content, { chat: forum, ...(thread === undefined ? {} : { message_thread_id: thread }) })
    assert.equal((await until(() => s.prompts.find(p => p.content?.[0]?.text === content))).sessionId, 'a')
  }
  s.message('Unbound named Topic', { chat: forum, message_thread_id: 80 })
  const hint = await s.request('sendMessage', p => p.chat_id === '-60' && p.message_thread_id === 80 && p.text.includes('/bind'))
  assert.match(hint.params.text, /administrator/)
  assert.equal(s.prompts.some(p => p.content?.[0]?.text === 'Unbound named Topic'), false)
  s.step('Default output')
  assert.equal((await s.request('sendRichMessage', p => p.chat_id === '-60' && p.rich_message.html.includes('Default output'))).params.message_thread_id, 1)
})

test('S1: General without a Default Bot explains /bind in English and Russian', async t => {
  const seed = team()
  seed.im = { connections: { im_forum: {
    id: 'im_forum', platform: 'telegram', account: { id: '7', name: '@fakebot' },
    settings: { token: 'S1-FAKE-TOKEN' }, secrets: {}, enabled: true,
    paired: [{ id: '9', name: 'Ann', access: 'all', at: 1 }], requests: [], chats: {}, createdAt: 1,
  } } }
  const s = await startBridge(t, { seed, pair: false, existingConnectionId: 'im_forum' })
  for (const language_code of ['en', 'ru-RU']) {
    const after = s.calls.length
    s.message('Hello General', { chat: forum, from: { id: 9, first_name: 'Ann', language_code } })
    const hint = await s.request('sendMessage', p => p.chat_id === '-60' && p.text.includes('/bind'), after)
    assert.match(hint.params.text, language_code === 'en' ? /administrator/ : /Администратор/)
  }
  assert.equal(s.prompts.length, 0)
})

test('S1: forum approval stays private to its Initiator in the originating Topic', async t => {
  const s = await startBridge(t)
  s.replies.getChatMember = { ok: true, result: { status: 'creator' } }
  await bind(s, 'Chief')
  s.message('Inspect forum report', { chat: forum, message_thread_id: 40 })
  const prompt = await until(() => s.prompts.find(p => p.content?.[0]?.text === 'Inspect forum report'))
  s.sessionEvent('turn/start', { turn: 1 })
  s.sessionEvent('user/message', { source: { kind: 'user', rpcId: prompt.requestId } })
  s.replies.sendRichMessage = p => ({ ok: true, result: p.ephemeral_message_parameters ? { message_id: 0, ephemeral_message_id: 701 } : { message_id: 702 } })
  const controller = new AbortController()
  t.after(() => controller.abort())
  const outcome = s.approval({ agent: s.agentOf('a'), toolName: 'bash', reason: 'Inspect forum', signal: controller.signal })
  const sent = await s.request('sendRichMessage', p => p.chat_id === '-60' && p.message_thread_id === 40 && p.ephemeral_message_parameters !== undefined)
  assert.equal(sent.params.message_thread_id, 40)
  assert.deepEqual(sent.params.ephemeral_message_parameters, { receiver_user_id: 9 })
  const data = /data="([^"]*:allow)"/.exec(sent.params.rich_message.html)[1]
  s.pushUpdate({ callback_query: { id: 'approval-forum', from: { id: 9 }, data, message: {
    chat: forum, message_thread_id: 40, message_id: 0, ephemeral_message_id: 701, receiver_user: { id: 9 },
  } } })
  assert.deepEqual(await outcome, ['allowed-once'])
  assert.equal((await s.request('editEphemeralMessageText')).params.ephemeral_message_id, 701)
})

test('S1: /bind requires current Telegram admin rights and current Access list; callbacks are Topic-local and single-use', async t => {
  const s = await startBridge(t, { seed: team() })
  s.replies.getChatMember = { ok: true, result: { status: 'member' } }
  s.message('/bind', { chat: forum, message_thread_id: 40 })
  await s.request('sendMessage', p => p.chat_id === '-60' && /administrator rights/.test(p.text))
  assert.equal(s.calls.some(call => call.method === 'sendRichMessage'), false)
  s.replies.getChatMember = { ok: false, error_code: 403, description: 'Cannot inspect member' }
  let after = s.calls.length
  s.message('/bind', { chat: forum, message_thread_id: 40, from: { id: 9, language_code: 'ru' } })
  await s.request('sendMessage', p => /права администратора/.test(p.text), after)
  s.replies.getChatMember = { ok: true, result: { status: 'administrator' } }
  after = s.calls.length
  s.message('/bind', { chat: forum, message_thread_id: 40 })
  const sent = await s.request('sendRichMessage', p => /Choose a Bot/.test(p.rich_message.html), after)
  const data = choice(sent, 'Writer')
  press(s, data, 41)
  await s.request('sendMessage', p => p.message_thread_id === 41 && /already answered/.test(p.text), after)
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: ['a'], roomIds: [] } })
  press(s, data)
  await s.request('sendMessage', p => /not on your Access list/.test(p.text), after)
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: 'all' })
  s.replies.getChatMember = { ok: true, result: { status: 'member' } }
  after = s.calls.length
  press(s, data)
  await s.request('sendMessage', p => /administrator rights/.test(p.text), after)
  s.replies.getChatMember = { ok: true, result: { status: 'administrator' } }
  press(s, data)
  await s.request('editMessageText', p => /Topic bound to Writer/.test(p.rich_message?.html), after)
  after = s.calls.length
  press(s, data)
  await s.request('sendMessage', p => /already answered/.test(p.text), after)
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: ['a'], roomIds: [] } })
  s.message('Denied input', { chat: forum, message_thread_id: 40 })
  await s.request('sendMessage', p => /not on your Access list/.test(p.text), after)
  assert.equal(s.prompts.some(p => p.content?.[0]?.text === 'Denied input'), false)
})

test('S1: ordinary groups keep their explicit binding and mention requirement', async t => {
  const s = await startBridge(t, { seed: team() })
  const chat = { id: -70, type: 'supergroup', title: 'Ordinary' }
  s.message('@fakebot /start', { chat })
  await s.request('sendMessage', p => p.chat_id === '-70' && /not bound/.test(p.text))
  await s.rt.imEndpoint('im-chat', { id: s.connection.id, chatKey: '-70', target: { botId: 'b' } })
  s.message('Ignored ordinary input', { chat })
  s.message('@fakebot Ordinary Writer', { chat })
  assert.equal((await until(() => s.prompts.find(p => p.content?.[0]?.text === 'Ordinary Writer'))).sessionId, 'b')
  assert.equal(s.prompts.some(p => p.content?.[0]?.text === 'Ignored ordinary input'), false)
  s.message('/bind@fakebot', { chat })
  await s.request('sendMessage', p => p.chat_id === '-70' && /forum supergroup/.test(p.text))
  s.step('Ordinary output', {}, 'b')
  assert.equal((await s.request('sendRichMessage', p => p.chat_id === '-70')).params.message_thread_id, undefined)
})

test('S1: mention-free forum routing ignores commands addressed to another Telegram bot', async t => {
  const s = await startBridge(t)
  s.replies.getChatMember = { ok: true, result: { status: 'administrator' } }
  const after = s.calls.length
  s.message('/bind@anotherbot', { chat: forum, message_thread_id: 40 })
  s.message('/status@fakebot', { chat: forum })
  await s.request('sendRichMessage', p => p.chat_id === '-60' && /Chief/.test(p.rich_message.html), after)
  assert.equal(s.calls.slice(after).some(call => call.method === 'getChatMember'), false)
  assert.equal(s.calls.slice(after).some(call => /Choose a Bot/.test(call.params.rich_message?.html ?? '')), false)
})

test('S1: rebinding a Topic never grants access to its old Cards, including after restart', async t => {
  const s = await startBridge(t, { seed: team() })
  s.replies.getChatMember = { ok: true, result: { status: 'administrator' } }
  await bind(s, 'Chief')
  await s.question({ question: 'Chief decision', options: [{ label: 'Yes' }] })
  const card = await s.request('sendRichMessage', p => p.chat_id === '-60' && /Chief decision/.test(p.rich_message.html))
  const data = choice(card, 'Yes')
  await bind(s, 'Writer')
  await s.restart()
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: ['b'], roomIds: [] } })
  for (const answer of [() => press(s, data), () => s.message('1', { chat: forum, message_thread_id: 40 })]) {
    const after = s.calls.length
    answer()
    await s.request('sendMessage', p => /not on your Access list/.test(p.text), after)
    assert.equal(s.rt.state.questions.a?.question, 'Chief decision')
  }
  await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: 'all' })
  press(s, data)
  await s.request('editMessageText', p => /Chief decision/.test(p.rich_message?.html) && /type="disabled"/.test(p.rich_message.html))
  assert.equal(s.rt.state.questions.a, undefined)
})
