import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startBridge, until } from './telegram-bridge.js'

const start = (s, attemptId = 'draft-1', step = 1, sessionId = 'a') => s.assistantStream({ type: 'start', attemptId, revision: 1, turn: 1, step }, sessionId)
const chunk = (s, text, attemptId = 'draft-1', sessionId = 'a') => s.assistantStream({ type: 'chunk', attemptId, revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text } }, sessionId)
const end = (s, attemptId = 'draft-1', outcome = { kind: 'committed', eventType: 'assistant/message', seq: 1 }, sessionId = 'a') => s.assistantStream({ type: 'end', attemptId, revision: 3, index: 1, outcome }, sessionId)

test('S1: a private step grows as one stoppable rich Draft then persists its full text', async t => {
  const s = await startBridge(t)
  start(s)
  chunk(s, '**A growing')
  const first = await s.request('sendRichMessageDraft')
  assert.equal(first.params.chat_id, 5)
  assert.ok(Number.isSafeInteger(first.params.draft_id) && first.params.draft_id !== 0)
  assert.equal(first.params.can_stop, true)
  chunk(s, ' step**')
  const grown = await s.request('sendRichMessageDraft', p => p.rich_message.html === '<p><b>A growing step</b></p>')
  assert.equal(grown.params.draft_id, first.params.draft_id)
  s.step('**A growing step**', { turn: 1, step: 1 })
  end(s)
  const final = await s.request('sendRichMessage', p => p.rich_message.html === '<p><b>A growing step</b></p>')
  assert.equal(final.params.draft_id, undefined)
})

test('S1: Draft Stop cancels the whole Bot turn and preserves only committed text', async t => {
  const s = await startBridge(t)
  s.rt.liveOf('a').turn = 1
  start(s)
  chunk(s, 'Already committed')
  const draft = await s.request('sendRichMessageDraft')
  const polling = s.calls.find(call => call.method === 'getUpdates')
  assert.ok(polling.params.allowed_updates.includes('stopped_message_generation'))
  s.pushUpdate({ stopped_message_generation: { chat: { id: 5, type: 'private' }, draft_id: draft.params.draft_id } })
  await until(() => s.agentOf('a').cancelled)
  s.step('Already committed', { turn: 1, step: 1 })
  end(s)
  await s.request('sendRichMessage', p => p.rich_message.html === '<p>Already committed</p>')
  await s.request('sendMessage', p => p.text === 'Stopped.')
})

test('S1: Stop on a private DS Bot group Draft stops the group, not the Bot own chat', async t => {
  const s = await startBridge(t, { seed: {
    version: 1, mainBotIds: ['a'],
    bots: { a: { id: 'a', name: 'Chief', sessionId: 'a', createdAt: 1 } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a'], mode: 'everyone', admin: 'a', named: true, sessions: { a: 'ar1' }, log: [], seq: 0 } },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  } })
  await s.rt.imEndpoint('im-chat', { id: s.connection.id, chatKey: '5', target: { roomId: 'r1' } })
  s.rt.liveOf('ar1').turn = 1
  s.rt.liveOf('a').turn = 1
  start(s, 'room-draft', 1, 'ar1')
  chunk(s, 'Group report', 'room-draft', 'ar1')
  const draft = await s.request('sendRichMessageDraft')
  s.pushUpdate({ stopped_message_generation: { chat: { id: 5, type: 'private' }, draft_id: draft.params.draft_id } })
  await until(() => s.agentOf('ar1').cancelled)
  assert.notEqual(s.agentOf('a').cancelled, true)
  await s.request('sendMessage', p => p.text === 'Stopped.')
})

test('S1: two steps of one turn use distinct Draft IDs and retain both Step messages', async t => {
  const s = await startBridge(t)
  start(s)
  chunk(s, 'First step')
  const first = await s.request('sendRichMessageDraft')
  s.step('First step', { turn: 1, step: 1 })
  end(s)
  await s.request('sendRichMessage', p => p.rich_message.html === '<p>First step</p>')
  start(s, 'draft-2', 2)
  chunk(s, 'Second step', 'draft-2')
  const second = await s.request('sendRichMessageDraft', p => p.rich_message.html === '<p>Second step</p>')
  assert.notEqual(second.params.draft_id, first.params.draft_id)
  s.step('Second step', { turn: 1, step: 2 })
  end(s, 'draft-2')
  await s.request('sendRichMessage', p => p.rich_message.html === '<p>Second step</p>')
  assert.equal(s.calls.filter(c => c.method === 'sendRichMessage').length, 2)
})

test('S1: Telegram groups receive final Step messages without Drafts or streaming edits', async t => {
  const s = await startBridge(t)
  s.message('@fakebot hello', { chat: { id: -20, type: 'supergroup', title: 'Team' } })
  await until(() => s.rt.imView().connections[0].chats['-20'])
  await s.rt.imEndpoint('im-chat', { id: s.connection.id, chatKey: '-20', target: { botId: 'a' } })
  s.message('@fakebot Start group turn', { chat: { id: -20, type: 'supergroup', title: 'Team' } })
  const prompt = await until(() => s.prompts.find(p => p.content?.[0]?.text === 'Start group turn'))
  s.sessionEvent('turn/start', { turn: 1 })
  s.sessionEvent('user/message', { source: { kind: 'user', rpcId: prompt.requestId } })
  start(s)
  chunk(s, 'Group final')
  s.step('Group final', { turn: 1, step: 1 })
  end(s)
  await s.request('sendRichMessage', p => p.chat_id === '-20')
  assert.equal(s.calls.filter(c => c.method === 'sendRichMessageDraft' && c.params.chat_id === -20).length, 0)
  assert.equal(s.calls.filter(c => c.method === 'editMessageText' && c.params.chat_id === '-20').length, 0)
})

test('S1: a fast stream coalesces to at most one Draft per second with the latest text', async t => {
  const s = await startBridge(t)
  const times = []
  s.replies.sendRichMessageDraft = () => { times.push(Date.now()); return { ok: true, result: true } }
  start(s)
  chunk(s, 'Fast')
  const first = await s.request('sendRichMessageDraft')
  for (let i = 0; i < 200; i++) chunk(s, '!')
  await delay(200)
  assert.equal(times.length, 1)
  const last = await s.request('sendRichMessageDraft', p => p.rich_message.html === `<p>Fast${'!'.repeat(200)}</p>`)
  assert.equal(last.params.draft_id, first.params.draft_id)
  assert.equal(times.length, 2)
  assert.ok(times[1] - times[0] >= 950)
  end(s, 'draft-1', { kind: 'abandoned' })
})

test('S1: abandoned Drafts expire without a permanent partial message or queued updates', async t => {
  const s = await startBridge(t)
  start(s)
  chunk(s, 'Uncommitted')
  await s.request('sendRichMessageDraft')
  chunk(s, ' queued')
  end(s, 'draft-1', { kind: 'abandoned' })
  chunk(s, ' late')
  await delay(1150)
  assert.equal(s.calls.filter(c => c.method === 'sendRichMessageDraft').length, 1)
  assert.equal(s.calls.filter(c => c.method === 'sendRichMessage').length, 0)
  assert.equal(s.calls.filter(c => c.method === 'editMessageText' || c.method === 'deleteMessage').length, 0)
})

test('S1: Stop ignores unknown, cross-chat, cross-Topic and expired Draft IDs', async t => {
  const s = await startBridge(t)
  s.rt.liveOf('a').turn = 1
  start(s)
  chunk(s, 'Scoped draft')
  const draft = await s.request('sendRichMessageDraft')
  for (const event of [
    { chat: { id: 5, type: 'private' }, draft_id: 0 },
    { chat: { id: 6, type: 'private' }, draft_id: draft.params.draft_id },
    { chat: { id: 5, type: 'private' }, message_thread_id: 11, draft_id: draft.params.draft_id },
    { chat: { id: 5, type: 'group' }, draft_id: draft.params.draft_id },
  ]) s.pushUpdate({ stopped_message_generation: event })
  s.message('/start')
  await s.request('sendMessage', p => p.text === 'Hello, I am Chief.')
  assert.notEqual(s.agentOf('a').cancelled, true)
  end(s, 'draft-1', { kind: 'abandoned' })
  s.pushUpdate({ stopped_message_generation: { chat: { id: 5, type: 'private' }, draft_id: draft.params.draft_id } })
  const after = s.calls.length
  s.message('/start')
  await s.request('sendMessage', p => p.text === 'Hello, I am Chief.', after)
  assert.notEqual(s.agentOf('a').cancelled, true)
})

test('S1: assistant streams hidden from the Bot own chat never leak into Drafts', async t => {
  const s = await startBridge(t, { seed: {
    version: 1, mainBotIds: ['a'],
    bots: { a: { id: 'a', name: 'Chief', sessionId: 'a', createdAt: 1 } },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: { a: [1] }, questions: {}, prefs: {}, revision: 0,
  } })
  start(s)
  chunk(s, 'Private exchange')
  end(s, 'draft-1', { kind: 'abandoned' })
  s.message('/start')
  await s.request('sendMessage', p => p.text === 'Hello, I am Chief.')
  assert.equal(s.calls.filter(c => c.method === 'sendRichMessageDraft').length, 0)
})
