import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge, until } from './telegram-bridge.js'

const buttons = html => [...html.matchAll(/<tg-button\s+([^>]*)>(.*?)<\/tg-button>/gs)].map(([, attrs, label]) => ({ attrs, label, data: /\bdata="([^"]*)"/.exec(attrs)?.[1] }))
const press = (s, data, id = 'card-click', extra = {}) => s.pushUpdate({ callback_query: {
  id, from: { id: 9, first_name: 'Ann', language_code: 'en' }, data,
  message: { message_id: 10, chat: { id: 5, type: 'private' } }, ...extra,
} })

test('S1: a question is a rich Card with embedded options and bounded callbacks', async (t) => {
  const s = await startBridge(t)
  await s.question({ question: 'Which report?', options: [{ label: 'Daily' }, { label: 'Weekly' }] })
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Which report?'))
  assert.match(sent.params.rich_message.html, /<tg-button-row>/)
  assert.equal(sent.params.reply_markup, undefined)
  const options = buttons(sent.params.rich_message.html)
  assert.deepEqual(options.map(b => b.label), ['Daily', 'Weekly'])
  for (const option of options) {
    assert.match(option.attrs, /type="callback_data"/)
    assert.ok(Buffer.byteLength(option.data) <= 64)
  }
  press(s, options[1].data)
  await until(() => s.agents.get('a')?.followed === 1)
  assert.match(JSON.stringify(s.agents.get('a').followups), /Weekly/)
})

test('S1: approval Card embeds styled buttons and collapsible tool details', async (t) => {
  const s = await startBridge(t)
  s.sessionEvent('tool/call', { name: 'bash', callId: 'inspect', arguments: JSON.stringify({ description: 'Inspect <report>', command: 'cat report && echo \"ok\"' }) })
  const controller = new AbortController()
  t.after(() => controller.abort())
  const outcome = s.approval({ agent: s.agentOf('a'), toolName: 'bash', callId: 'inspect', reason: 'Inspect report', signal: controller.signal })
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('asks for approval'))
  const html = sent.params.rich_message.html
  assert.match(html, /<blockquote expandable>[\s\S]*Inspect &lt;report&gt;[\s\S]*cat report &amp;&amp; echo &quot;ok&quot;[\s\S]*<\/blockquote>/)
  const options = buttons(html)
  assert.deepEqual(options.map(b => b.label), ['Allow once', 'Reject'])
  assert.match(options[0].attrs, /style="success"/)
  assert.match(options[1].attrs, /style="danger"/)
  for (const option of options) assert.ok(Buffer.byteLength(option.data) <= 64)
  press(s, options[0].data)
  assert.deepEqual(await outcome, ['allowed-once'])
  const edited = await s.request('editMessageText', p => p.rich_message?.html.includes('asks for approval'))
  assert.deepEqual(buttons(edited.params.rich_message.html).map(b => [b.label, b.data]), [['Allow once', undefined]])
  assert.match(buttons(edited.params.rich_message.html)[0].attrs, /type="disabled"/)
})

test('S1: a Telegram answer settles the Card to only the selected disabled button', async (t) => {
  const s = await startBridge(t)
  await s.question({ question: 'Choose a period', options: [{ label: 'Daily' }, { label: 'Weekly' }] })
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose a period'))
  const option = buttons(sent.params.rich_message.html)[1]
  press(s, option.data)
  const edited = await s.request('editMessageText', p => p.rich_message?.html.includes('Choose a period'))
  const settled = buttons(edited.params.rich_message.html)
  assert.deepEqual(settled.map(b => b.label), ['Weekly'])
  assert.match(settled[0].attrs, /type="disabled"/)
  assert.equal(settled[0].data, undefined)
  assert.equal(edited.params.rich_message.html.includes('>Daily</tg-button>'), false)
  await until(() => s.agents.get('a')?.followed === 1)
  press(s, option.data, 'stale-choice')
  await s.request('sendMessage', p => p.text === 'This card was already answered.')
  assert.equal(s.agents.get('a').followed, 1)
})

test('S1: a question answered on the computer preserves its selected disabled option', async (t) => {
  const s = await startBridge(t)
  await s.question({ question: 'Desktop choice?', options: [{ label: 'Daily' }, { label: 'Weekly' }] })
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Desktop choice?'))
  const id = buttons(sent.params.rich_message.html)[0].data.slice(2, -2)
  await s.rt.answerQuestion('a', id, { selected: ['Weekly'] })
  const edited = await s.request('editMessageText', p => p.rich_message?.html.includes('Desktop choice?'))
  assert.deepEqual(buttons(edited.params.rich_message.html).map(b => b.label), ['Weekly'])
  assert.match(buttons(edited.params.rich_message.html)[0].attrs, /type="disabled"/)
})

test('S1: approval answered by DSH settles to the disabled rejected option', async (t) => {
  const s = await startBridge(t)
  let answer
  const outcome = s.approval({ agent: s.agentOf('a'), toolName: 'bash', reason: 'Desktop approval' }, () => new Promise(resolve => { answer = resolve }))
  await s.request('sendRichMessage', p => p.rich_message.html.includes('Desktop approval'))
  answer('rejected')
  assert.deepEqual(await outcome, ['rejected'])
  const edited = await s.request('editMessageText', p => p.rich_message?.html.includes('Desktop approval'))
  assert.deepEqual(buttons(edited.params.rich_message.html).map(b => b.label), ['Reject'])
  assert.match(buttons(edited.params.rich_message.html)[0].attrs, /type="disabled" style="danger"/)
})

test('S1: numeric replies still answer question and approval Cards', async (t) => {
  const s = await startBridge(t)
  await s.question({ question: 'Numeric choice?', options: [{ label: 'Daily' }, { label: 'Weekly' }] })
  await s.request('sendRichMessage', p => p.rich_message.html.includes('Numeric choice?'))
  s.message('2')
  const edited = await s.request('editMessageText', p => p.rich_message?.html.includes('Numeric choice?'))
  assert.deepEqual(buttons(edited.params.rich_message.html).map(b => b.label), ['Weekly'])
  assert.match(JSON.stringify(s.agents.get('a').followups), /Weekly/)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const outcome = s.approval({ agent: s.agentOf('a'), toolName: 'bash', reason: 'Numeric approval', signal: controller.signal })
  await s.request('sendRichMessage', p => p.rich_message.html.includes('Numeric approval'))
  s.message('2')
  assert.deepEqual(await outcome, ['rejected'])
  await s.request('editMessageText', p => p.rich_message?.html.includes('Numeric approval'))
})

test('S1: secret and view Cards stay text notices without buttons', async (t) => {
  const s = await startBridge(t)
  s.rt.state.secretRequests = { a: [{ id: 'secret-test', name: 'TEST_KEY', status: 'pending', askedAt: 1 }] }
  s.rt.state.views = { a: { id: 'view-test', title: 'Computer form', view: {} } }
  await s.rt.save()
  const secret = await s.request('sendMessage', p => p.text.includes('TEST_KEY'))
  const view = await s.request('sendMessage', p => p.text.includes('shared a card'))
  assert.equal(secret.params.reply_markup, undefined)
  assert.equal(view.params.reply_markup, undefined)
  assert.match(secret.params.text, /fill it on the computer/)
  assert.match(view.params.text, /computer or the phone app/)
})

test('S1: an old Bot API receives a text Card fallback and a disabled settled keyboard', async (t) => {
  const s = await startBridge(t)
  s.replies.sendRichMessage = { ok: false, error_code: 404, description: 'Method not found' }
  await s.question({ question: 'Legacy server?', options: [{ label: 'Daily' }, { label: 'Weekly' }] })
  const sent = await s.request('sendMessage', p => p.text.includes('Legacy server?'))
  assert.deepEqual(sent.params.reply_markup.inline_keyboard.flat().map(b => b.text), ['Daily', 'Weekly'])
  press(s, sent.params.reply_markup.inline_keyboard[1][0].callback_data)
  const edited = await s.request('editMessageText', p => p.text?.includes('Legacy server?'))
  assert.deepEqual(edited.params.reply_markup.inline_keyboard, [[{ text: 'Weekly', disabled: {} }]])
})

test('S1: a rich Card formatting failure stays visible instead of degrading to text', async (t) => {
  const s = await startBridge(t)
  s.replies.sendRichMessage = { ok: false, error_code: 400, description: 'Bad rich formatting' }
  const after = s.calls.length
  await s.question({ question: 'Broken formatting?', options: [{ label: 'Daily' }] })
  await s.request('sendRichMessage', p => p.rich_message.html.includes('Broken formatting?'), after)
  await until(() => s.rt.imStatusView()[s.connection.id]?.error === 'Bad rich formatting')
  assert.equal(s.calls.slice(after).some(call => call.method === 'sendMessage'), false)
})
