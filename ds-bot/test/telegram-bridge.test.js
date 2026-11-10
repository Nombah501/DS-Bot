import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge, until } from './telegram-bridge.js'

test('S1: a Bot step reaches the paired person through the real Telegram adapter', async (t) => {
  const s = await startBridge(t)
  // DSH 0.2.2-rc.1 publishes { agent, frame }; only start carries turn/step.
  s.assistantStream({ type: 'start', attemptId: 'a:1', revision: 1, turn: 1, step: 1 })
  s.assistantStream({ type: 'chunk', attemptId: 'a:1', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'A completed Bot step' } })
  s.step('A completed Bot step')
  const sent = await s.request('sendMessage', params => params.text === 'A completed Bot step')
  assert.equal(sent.params.chat_id, '5')
  s.assistantStream({ type: 'end', attemptId: 'a:1', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })
})

test('S1: a paired person update becomes a user message in the Bot session', async (t) => {
  const s = await startBridge(t)
  s.message('Please inspect the report')
  const request = await until(() => s.prompts.find(prompt => prompt.content?.[0]?.text === 'Please inspect the report'))
  assert.equal(request.sessionId, 'a')
  assert.equal(request.mode, 'queue')
  assert.match(request.requestId, /^im:telegram:/)
  assert.deepEqual(request.content, [{ type: 'text', text: 'Please inspect the report' }])
})

test('S1: a question reaches Telegram and a paired person button answers it', async (t) => {
  const s = await startBridge(t)
  await s.question({ question: 'Which report?', options: [{ label: 'Daily' }, { label: 'Weekly' }] })
  const card = await s.request('sendMessage', params => /Which report\?/.test(params.text))
  const button = card.params.reply_markup.inline_keyboard.flat()[0]
  s.pushUpdate({ callback_query: { id: 'q1', from: { id: 9, first_name: 'Ann' }, data: button.callback_data, message: { message_id: 10, chat: { id: 5, type: 'private' } } } })
  await until(() => s.agents.get('a')?.followed === 1)
  await s.request('answerCallbackQuery', params => params.callback_query_id === 'q1')
})

test('S1: a Telegram approval button resolves the DSH request', async (t) => {
  const s = await startBridge(t)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const outcome = s.approval({ agent: s.agentOf('a'), toolName: 'bash', reason: 'Inspect the report', signal: controller.signal })
  const card = await s.request('sendMessage', params => /Inspect the report/.test(params.text))
  const button = card.params.reply_markup.inline_keyboard.flat().find(item => item.callback_data.endsWith(':allow'))
  s.pushUpdate({ callback_query: { id: 'a1', from: { id: 9, first_name: 'Ann' }, data: button.callback_data, message: { message_id: 11, chat: { id: 5, type: 'private' } } } })
  assert.deepEqual(await outcome, ['allowed-once'])
})
