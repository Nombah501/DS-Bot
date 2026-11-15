import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge, until } from './telegram-bridge.js'

test('S1: a Bot step reaches the paired person through the real Telegram adapter', async (t) => {
  const s = await startBridge(t)
  // DSH 0.2.2-rc.1 publishes { agent, frame }; only start carries turn/step.
  s.assistantStream({ type: 'start', attemptId: 'a:1', revision: 1, turn: 1, step: 1 })
  s.assistantStream({ type: 'chunk', attemptId: 'a:1', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'A completed Bot step' } })
  s.step('A completed Bot step')
  const sent = await s.request('sendRichMessage', params => params.rich_message.html === '<p>A completed Bot step</p>')
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
  const card = await s.request('sendRichMessage', params => /Which report\?/.test(params.rich_message.html))
  const button = { callback_data: /data="([^"]+)"/.exec(card.params.rich_message.html)[1] }
  s.pushUpdate({ callback_query: { id: 'q1', from: { id: 9, first_name: 'Ann' }, data: button.callback_data, message: { message_id: 10, chat: { id: 5, type: 'private' } } } })
  await until(() => s.agents.get('a')?.followed === 1)
  await s.request('answerCallbackQuery', params => params.callback_query_id === 'q1')
})

test('S1: a Telegram approval button resolves the DSH request', async (t) => {
  const s = await startBridge(t)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const outcome = s.approval({ agent: s.agentOf('a'), toolName: 'bash', reason: 'Inspect the report', signal: controller.signal })
  const card = await s.request('sendRichMessage', params => /Inspect the report/.test(params.rich_message.html))
  const button = { callback_data: /data="([^"]+:allow)"/.exec(card.params.rich_message.html)[1] }
  s.pushUpdate({ callback_query: { id: 'a1', from: { id: 9, first_name: 'Ann' }, data: button.callback_data, message: { message_id: 11, chat: { id: 5, type: 'private' } } } })
  assert.deepEqual(await outcome, ['allowed-once'])
})

test('S1: a working Bot sends Telegram typing with the chat identifier', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const s = await startBridge(t)
  s.rt.live.set(s.rt.chatOf('a'), { turn: 1 })
  t.mock.timers.tick(4000)
  const action = await s.request('sendChatAction')
  assert.deepEqual(action.params, { chat_id: '5', action: 'typing' })
})

test('S1: fake Telegram refuses unlisted methods and unsupported chat kinds with Bot API errors', async t => {
  const s = await startBridge(t)
  for (const chat of [
    { id: -20, type: 'group' },
    { id: -30, type: 'supergroup' },
    { id: -40, type: 'supergroup', is_forum: true },
  ]) s.message('/status@anotherbot', { chat })
  s.replies.sendMadeUpMessage = { ok: true, result: true }
  s.replies.sendWidget = { ok: true, result: { message_id: 900 } }
  // HTTP error envelope: https://core.telegram.org/bots/api#making-requests
  const cases = [
    ['unlisted method', 'sendMadeUpMessage', { chat_id: 5 }],
    ['inherited object property', 'constructor', { chat_id: 5 }],
    ['private-only widget in a group', 'sendWidget', { chat_id: -20, html: '<p>Status</p>' }],
    ['private-only widget in a supergroup', 'sendWidget', { chat_id: -30, html: '<p>Status</p>' }],
    ['private-only widget in a forum', 'sendWidget', { chat_id: -40, html: '<p>Status</p>' }],
    ['widget editing in a forum', 'editMessageWidgetData', { chat_id: -40, message_id: 1, chat_data: '{}' }],
    ['private-only Draft in a group', 'sendRichMessageDraft', { chat_id: -20, draft_id: 1, rich_message: { html: '<p>Draft</p>' } }],
    ['Topic creation in an ordinary group', 'createForumTopic', { chat_id: -20, name: 'Work' }],
    ['Topic editing in an ordinary group', 'editForumTopic', { chat_id: -20, message_thread_id: 1, name: 'Work' }],
    ['Topic creation in a non-forum supergroup', 'createForumTopic', { chat_id: -30, name: 'Work' }],
    ['Topic editing in a non-forum supergroup', 'editForumTopic', { chat_id: -30, message_thread_id: 1, name: 'Work' }],
    ['Topic closing in an ordinary group', 'closeForumTopic', { chat_id: -20, message_thread_id: 1 }],
    ['Topic reopening in a non-forum supergroup', 'reopenForumTopic', { chat_id: -30, message_thread_id: 1 }],
    ['Topic closing in a private chat', 'closeForumTopic', { chat_id: 5, message_thread_id: 1 }],
    ['Topic reopening in a private chat', 'reopenForumTopic', { chat_id: 5, message_thread_id: 1 }],
  ]
  for (const [name, method, params] of cases) {
    await t.test(name, async () => {
      const response = await fetch(`${s.api}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
      })
      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.equal(body.error_code, 400)
      assert.match(body.description, /^Bad Request: /)
      if (['closeForumTopic', 'reopenForumTopic'].includes(method)) {
        assert.equal(body.description, 'Bad Request: the chat is not a supergroup forum')
      }
    })
  }
  await t.test('supported private, group, supergroup and forum scopes still succeed', async () => {
    for (const [method, params] of [
      ...[5, -20, -30, -40].map(chat_id => ['sendMessage', { chat_id, text: 'Supported chat' }]),
      ['sendWidget', { chat_id: 5, html: '<p>Status</p>' }],
      ['sendRichMessageDraft', { chat_id: 5, draft_id: 1, rich_message: { html: '<p>Draft</p>' } }],
      ['createForumTopic', { chat_id: 5, name: 'Work' }],
      ['createForumTopic', { chat_id: -40, name: 'Work' }],
      ['editForumTopic', { chat_id: -40, message_thread_id: 1, name: 'Work' }],
      ['closeForumTopic', { chat_id: -40, message_thread_id: 1 }],
      ['reopenForumTopic', { chat_id: -40, message_thread_id: 1 }],
      ['answerCallbackQuery', { callback_query_id: 'scope-query' }],
      ['answerWidgetQuery', { widget_query_id: 'scope-widget' }],
    ]) {
      const response = await fetch(`${s.api}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
      })
      assert.equal(response.status, 200, `${method}: ${params.chat_id}`)
      assert.equal((await response.json()).ok, true)
    }
  })
})
