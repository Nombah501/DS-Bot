import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge, until } from './telegram-bridge.js'

const group = { id: -50, type: 'supergroup', title: 'Team' }
const actionOf = sent => /data="([^"]*:allow)"/.exec(sent.params.rich_message.html)[1]
const press = (s, sent, senderId = 9, extra = {}) => s.pushUpdate({ callback_query: {
  id: `private-${senderId}`, from: { id: senderId, first_name: 'Person', language_code: 'en' },
  message: { message_id: 0, chat: group, ephemeral_message_id: 701, receiver_user: { id: 9 }, ...extra },
  data: actionOf(sent),
} })
const startGroupTurn = async (s, turn = 1) => {
  s.message('@fakebot /start', { chat: group })
  await s.request('sendMessage', p => p.chat_id === '-50')
  await s.rt.imEndpoint('im-chat', { id: s.connection.id, chatKey: '-50', target: { botId: 'a' } })
  s.message('@fakebot inspect report', { chat: group })
  const prompt = await until(() => s.prompts.find(p => p.content?.[0]?.text === 'inspect report'))
  s.sessionEvent('turn/start', { turn })
  s.sessionEvent('user/message', { source: { kind: 'user', rpcId: prompt.requestId } })
}
const approve = (t, s, next) => {
  const controller = new AbortController()
  t.after(() => controller.abort())
  return s.approval({ agent: s.agentOf('a'), toolName: 'bash', reason: 'Inspect report', signal: controller.signal }, next)
}
const ephemeral = s => { s.replies.sendRichMessage = p => ({ ok: true, result: p.ephemeral_message_parameters ? { message_id: 0, ephemeral_message_id: 701, receiver_user: { id: 9 } } : { message_id: 702 } }) }

test('S1: a group approval is private to the paired person who started its turn', async t => {
  const s = await startBridge(t)
  ephemeral(s)
  await startGroupTurn(s)
  const outcome = approve(t, s)
  const sent = await s.request('sendRichMessage', p => p.chat_id === '-50' && p.rich_message.html.includes('asks for approval'))
  assert.deepEqual(sent.params.ephemeral_message_parameters, { receiver_user_id: 9 })
  press(s, sent)
  assert.deepEqual(await outcome, ['allowed-once'])
  const edited = await s.request('editEphemeralMessageText')
  assert.equal(edited.params.chat_id, '-50')
  assert.equal(edited.params.receiver_user_id, 9)
  assert.equal(edited.params.ephemeral_message_id, 701)
  assert.equal(edited.params.message_id, undefined)
  assert.match(edited.params.rich_message.html, /type="disabled"[^>]*>Allow once/)
})

test('S1: another paired person cannot answer a Private card by button or number', async t => {
  const s = await startBridge(t)
  ephemeral(s)
  s.message('hello', { from: { id: 10, first_name: 'Bob' } })
  await until(() => s.rt.imView().connections[0].requests.some(p => p.id === '10'))
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '10', allow: true })
  await startGroupTurn(s)
  const outcome = approve(t, s)
  const sent = await s.request('sendRichMessage', p => p.chat_id === '-50' && p.rich_message.html.includes('asks for approval'))
  press(s, sent, 10)
  await s.request('sendMessage', p => /Only the Initiator/.test(p.text))
  const after = s.calls.length
  s.message('@fakebot 1', { chat: group, from: { id: 10, first_name: 'Bob', language_code: 'ru' } })
  await s.request('sendMessage', p => /Только инициатор/.test(p.text), after)
  assert.equal(s.prompts.length, 1)
  assert.equal(s.rt.approvalsView().length, 1)
  press(s, sent)
  assert.deepEqual(await outcome, ['allowed-once'])
})

test('S1: an unanswered Private card becomes public after five minutes and settles there', async t => {
  const s = await startBridge(t)
  ephemeral(s)
  await startGroupTurn(s)
  const outcome = approve(t, s)
  await s.request('sendRichMessage', p => p.chat_id === '-50' && p.ephemeral_message_parameters)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(5 * 60 * 1000)
  const sent = await s.request('sendRichMessage', p => p.chat_id === '-50' && !p.ephemeral_message_parameters)
  const deleted = await s.request('deleteEphemeralMessage')
  assert.deepEqual(deleted.params, { chat_id: '-50', receiver_user_id: 9, ephemeral_message_id: 701 })
  press(s, sent, 9, { message_id: 702, ephemeral_message_id: undefined, receiver_user: undefined })
  assert.deepEqual(await outcome, ['allowed-once'])
  const edited = await s.request('editMessageText', p => p.message_id === 702)
  assert.match(edited.params.rich_message.html, /type="disabled"[^>]*>Allow once/)
})

test('S1: Initiator survives a host restart and ends with its turn', async t => {
  const s = await startBridge(t)
  ephemeral(s)
  await startGroupTurn(s)
  await s.restart()
  const outcome = approve(t, s)
  const sent = await s.request('sendRichMessage', p => p.chat_id === '-50' && p.rich_message.html.includes('asks for approval'))
  assert.deepEqual(sent.params.ephemeral_message_parameters, { receiver_user_id: 9 })
  press(s, sent)
  assert.deepEqual(await outcome, ['allowed-once'])
  s.sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await s.restart()
  const after = s.calls.length
  const autonomous = approve(t, s)
  const publicCard = await s.request('sendRichMessage', p => p.chat_id === '5' && p.rich_message.html.includes('asks for approval'), after)
  assert.equal(publicCard.params.ephemeral_message_parameters, undefined)
  press(s, publicCard, 9, { chat: { id: 5, type: 'private' }, message_id: 702, ephemeral_message_id: undefined, receiver_user: undefined })
  assert.deepEqual(await autonomous, ['allowed-once'])
})

test('S1: a turn started on the computer has no Initiator, even after a Telegram turn', async t => {
  const s = await startBridge(t)
  ephemeral(s)
  await startGroupTurn(s)
  s.sessionEvent('turn/start', { turn: 2 })
  s.sessionEvent('user/message', { source: { kind: 'user', rpcId: 'desktop-request' } })
  const outcome = approve(t, s)
  const sent = await s.request('sendRichMessage', p => p.chat_id === '5' && p.rich_message.html.includes('asks for approval'))
  assert.equal(sent.params.ephemeral_message_parameters, undefined)
  press(s, sent, 9, { chat: { id: 5, type: 'private' }, message_id: 702, ephemeral_message_id: undefined, receiver_user: undefined })
  assert.deepEqual(await outcome, ['allowed-once'])
})

test('S1: an answer on the computer settles the originating Private card without broadcasting another copy', async t => {
  const s = await startBridge(t)
  ephemeral(s)
  await startGroupTurn(s)
  let answer
  const outcome = approve(t, s, () => new Promise(resolve => { answer = resolve }))
  await s.request('sendRichMessage', p => p.chat_id === '-50' && p.ephemeral_message_parameters)
  answer('rejected')
  assert.deepEqual(await outcome, ['rejected'])
  const privateEdit = await s.request('editEphemeralMessageText')
  assert.equal(s.calls.some(call => call.method === 'sendRichMessage' && call.params.chat_id === '5' && /asks for approval/.test(call.params.rich_message.html)), false)
  for (const edited of [privateEdit]) {
    assert.match(edited.params.rich_message.html, /type="disabled"[^>]*>Reject/)
    assert.doesNotMatch(edited.params.rich_message.html, /type="callback"/)
  }
})

test('S1: an undelivered Private card still becomes public at its deadline', async t => {
  const s = await startBridge(t)
  s.replies.sendRichMessage = p => p.ephemeral_message_parameters
    ? { ok: false, error_code: 403, description: 'Receiver unavailable' }
    : { ok: true, result: { message_id: 702 } }
  await startGroupTurn(s)
  const outcome = approve(t, s)
  await s.request('sendRichMessage', p => p.chat_id === '-50' && p.ephemeral_message_parameters)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(5 * 60 * 1000)
  const sent = await s.request('sendRichMessage', p => p.chat_id === '-50' && !p.ephemeral_message_parameters)
  press(s, sent, 9, { message_id: 702, ephemeral_message_id: undefined, receiver_user: undefined })
  assert.deepEqual(await outcome, ['allowed-once'])
  assert.equal(s.calls.some(c => c.method === 'deleteEphemeralMessage'), false)
})
