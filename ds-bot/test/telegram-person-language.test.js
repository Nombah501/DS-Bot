import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge, until } from './telegram-bridge.js'

const from = language_code => ({ id: 9, first_name: 'Ann', language_code })
const command = async (s, body, expected, extra = {}) => {
  const after = s.calls.length
  s.message(body, extra)
  return s.request('sendMessage', p => p.text.includes(expected), after)
}

test('S1: a paired person pins Russian across devices, Cards, callback hints and restart', async t => {
  const s = await startBridge(t)
  await command(s, '/lang ru', 'Язык: ru.')
  await command(s, '/start', 'Здравствуйте, я Chief.', { from: from('en') })
  await command(s, '/stop', 'Сейчас ничего не выполняется.', { from: from('en') })
  await s.question({ question: 'Keep original content?', options: [{ label: 'Yes' }] })
  const card = await s.request('sendRichMessage', p => p.rich_message.html.includes('Chief спрашивает:'))
  assert.match(card.params.rich_message.html, /ответьте номером/)
  assert.match(card.params.rich_message.html, /Keep original content/)
  const after = s.calls.length
  s.pushUpdate({ callback_query: { id: 'stale-en', from: from('en'), data: 'q:missing:0', message: { message_id: 10, chat: { id: 5, type: 'private' } } } })
  await s.request('sendMessage', p => p.text === 'На эту карточку уже ответили.', after)
  await s.restart()
  await command(s, '/start', 'Здравствуйте, я Chief.', { from: from('en') })
  await command(s, '/lang', 'Язык: ru.')
  assert.equal(s.prompts.length, 0)
})

test('S1: auto and legacy people follow Telegram; invalid and empty /lang preserve the choice', async t => {
  const s = await startBridge(t)
  await command(s, '/lang', 'Language: auto.')
  await command(s, '/start', 'Здравствуйте, я Chief.', { from: from('ru') })
  await command(s, '/lang en', 'Language: en.', { from: from('ru') })
  await command(s, '/start', 'Hello, I am Chief.', { from: from('ru') })
  for (const body of ['/lang xx', '/lang', '/lang ru extra']) {
    const reply = await command(s, body, 'Language: en.', { from: from('ru') })
    assert.match(reply.params.text, /\/lang ru.*\/lang en.*\/lang auto/)
    await command(s, '/start', 'Hello, I am Chief.', { from: from('ru') })
  }
  await command(s, '/lang auto', 'Язык: auto.', { from: from('ru') })
  await command(s, '/start', 'Hello, I am Chief.', { from: from('en') })
  await command(s, '/start', 'Здравствуйте, я Chief.', { from: from('ru') })
  await s.restart()
  await command(s, '/start', 'Hello, I am Chief.', { from: from('en') })
  assert.equal(s.prompts.length, 0)
})

test('S1: a private Topic and its Status panel use the paired owner preference', async t => {
  const s = await startBridge(t, {
    pair: false,
    getMe: { id: 7, username: 'fakebot', is_bot: true, has_topics_enabled: true },
    apiReplies: { createForumTopic: { ok: true, result: { message_thread_id: 101 } } },
  })
  await command(s, 'hello', 'connection request')
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '9', allow: true })
  await s.request('createForumTopic')
  await command(s, '/lang ru', 'Язык: ru.')
  await command(s, '/start', 'Здравствуйте, я Chief.', { message_thread_id: 101, from: from('en') })
  await s.question({ question: 'Topic choice?', options: [{ label: 'Yes' }] })
  const card = await s.request('sendRichMessage', p => /Topic choice/.test(p.rich_message.html))
  assert.equal(card.params.message_thread_id, 101)
  assert.match(card.params.rich_message.html, /Chief спрашивает:.*Topic choice/s)
  s.message('/status', { message_thread_id: 101, from: from('en') })
  const panel = await s.request('sendWidget')
  assert.match(panel.params.html, /Остановить/)
  assert.equal(JSON.parse(panel.params.chat_data).state, 'Ждёт ответа на карточку')
  await s.request('pinChatMessage')
})

test('S1: group Cards follow the last speaker but a Private card follows its Initiator', async t => {
  const s = await startBridge(t)
  const group = { id: -50, type: 'supergroup', title: 'Team' }
  const bob = { id: 10, first_name: 'Bob', language_code: 'en' }
  await command(s, '/lang ru', 'Язык: ru.')
  await command(s, '@fakebot /start', 'Эта группа ещё не привязана', { chat: group })
  await s.rt.imEndpoint('im-chat', { id: s.connection.id, chatKey: '-50', target: { botId: 'a' } })
  await command(s, '@fakebot /start', 'connection request', { chat: group, from: bob })
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '10', allow: true })
  s.message('@fakebot inspect report', { chat: group, from: from('en') })
  const prompt = await until(() => s.prompts.find(p => p.content?.[0]?.text === 'inspect report'))
  s.sessionEvent('turn/start', { turn: 1 })
  s.sessionEvent('user/message', { source: { kind: 'user', rpcId: prompt.requestId } })
  await s.question({ question: 'Russian group choice?', options: [{ label: 'Yes' }] })
  const russianCard = await s.request('sendRichMessage', p => p.chat_id === '-50' && /Russian group choice/.test(p.rich_message.html))
  assert.match(russianCard.params.rich_message.html, /Chief спрашивает:/)
  await command(s, '@fakebot /start', 'Hello, I am Chief.', { chat: group, from: bob })
  await s.question({ question: 'Group choice?', options: [{ label: 'Yes' }] })
  const publicCard = await s.request('sendRichMessage', p => p.chat_id === '-50' && /Group choice/.test(p.rich_message.html))
  assert.match(publicCard.params.rich_message.html, /Chief asks:/)
  await s.restart()
  s.replies.sendRichMessage = p => ({ ok: true, result: p.ephemeral_message_parameters
    ? { message_id: 0, ephemeral_message_id: 701, receiver_user: { id: 9 } } : { message_id: 702 } })
  const controller = new AbortController()
  t.after(() => controller.abort())
  const outcome = s.approval({ agent: s.agentOf('a'), toolName: 'bash', reason: 'Inspect report', signal: controller.signal })
  const privateCard = await s.request('sendRichMessage', p => p.ephemeral_message_parameters?.receiver_user_id === 9)
  assert.match(privateCard.params.rich_message.html, /Chief запрашивает разрешение:/)
  assert.match(privateCard.params.rich_message.html, /Разрешить один раз/)
  const data = /data="([^"]*:allow)"/.exec(privateCard.params.rich_message.html)[1]
  s.pushUpdate({ callback_query: {
    id: 'private-en', from: from('en'), data,
    message: { message_id: 0, ephemeral_message_id: 701, receiver_user: { id: 9 }, chat: group },
  } })
  assert.deepEqual(await outcome, ['allowed-once'])
  await s.request('editEphemeralMessageText', p => /— Разрешить один раз/.test(p.rich_message.html))
})
