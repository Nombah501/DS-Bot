import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge, until } from './telegram-bridge.js'

const buttons = html => [...html.matchAll(/<tg-button\s+([^>]*)>(.*?)<\/tg-button>/gs)].map(([, attrs, label]) => ({ attrs, label, data: /\bdata="([^"]*)"/.exec(attrs)?.[1] }))
const press = (s, data, id = 'multi-click', extra = {}) => s.pushUpdate({ callback_query: {
  id, from: { id: 9, first_name: 'Ann', language_code: 'en' }, data,
  message: { message_id: 10, chat: { id: 5, type: 'private' } }, ...extra,
} })
const question = { question: 'Choose reports', multiSelect: true, options: [{ label: 'Daily' }, { label: 'Weekly' }, { label: 'Monthly' }] }

test('S1: a multi-select question has unchecked options and a localized Done button', async (t) => {
  const s = await startBridge(t)
  await s.question(question)
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose reports'))
  assert.deepEqual(buttons(sent.params.rich_message.html).map(b => b.label), ['☐ Daily', '☐ Weekly', '☐ Monthly', 'Done'])
  assert.match(sent.params.rich_message.html, /reply with the numbers, separated by spaces/)
  for (const option of buttons(sent.params.rich_message.html)) assert.ok(Buffer.byteLength(option.data) <= 64)
})

test('S1: toggles edit the Card without answering, and Done settles the chosen set once', async (t) => {
  const s = await startBridge(t)
  await s.question(question)
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose reports'))
  const options = buttons(sent.params.rich_message.html)
  let after = s.calls.length
  press(s, options[0].data)
  const toggled = await s.request('editMessageText', p => p.rich_message?.html.includes('Choose reports'), after)
  assert.equal(toggled.params.message_id !== undefined, true)
  assert.deepEqual(buttons(toggled.params.rich_message.html).map(b => b.label), ['☑ Daily', '☐ Weekly', '☐ Monthly', 'Done'])
  assert.equal(s.agents.get('a')?.followed ?? 0, 0)
  assert.equal(s.prompts.length, 0)
  after = s.calls.length
  press(s, options[1].data, 'pick-weekly')
  await s.request('editMessageText', p => p.rich_message?.html.includes('☑ Weekly'), after)
  after = s.calls.length
  press(s, options[0].data, 'unpick-daily')
  const unchecked = await s.request('editMessageText', p => p.rich_message?.html.includes('☐ Daily'), after)
  assert.deepEqual(buttons(unchecked.params.rich_message.html).map(b => b.label), ['☐ Daily', '☑ Weekly', '☐ Monthly', 'Done'])
  after = s.calls.length
  press(s, options[2].data, 'pick-monthly')
  await s.request('editMessageText', p => p.rich_message?.html.includes('☑ Monthly'), after)
  assert.equal(s.agents.get('a')?.followed ?? 0, 0)
  after = s.calls.length
  press(s, options[3].data, 'finish')
  await until(() => s.agents.get('a')?.followed === 1)
  const settled = await s.request('editMessageText', p => p.rich_message?.html.includes('type="disabled"'), after)
  assert.deepEqual(buttons(settled.params.rich_message.html).map(b => [b.label, b.data]), [['Weekly', undefined], ['Monthly', undefined]])
  assert.equal(buttons(settled.params.rich_message.html).every(b => b.attrs === 'type="disabled"'), true)
  const answer = JSON.parse(s.agents.get('a').followups[0].content[0].text)
  assert.deepEqual(answer.answers[0].selected, ['Weekly', 'Monthly'])
  press(s, options[3].data, 'finish-again')
  await s.request('sendMessage', p => p.text === 'This card was already answered.', after)
  assert.equal(s.agents.get('a').followed, 1)
})

for (const [language, done, notice] of [['en', 'Done', 'Select at least one option.'], ['ru-RU', 'Готово', 'Выберите хотя бы один вариант.']]) {
  test(`S1: Done without selections keeps the Card open in ${language}`, async (t) => {
    const s = await startBridge(t)
    const from = { id: 9, first_name: 'Ann', language_code: language }
    s.message('/start', { from })
    await s.request('sendMessage', p => p.text.includes(language === 'en' ? 'Hello' : 'Здравствуйте'))
    await s.question(question)
    const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose reports'))
    const options = buttons(sent.params.rich_message.html)
    assert.equal(options.at(-1).label, done)
    press(s, options.at(-1).data, 'empty', { from })
    await s.request('sendMessage', p => p.text === notice)
    assert.equal(s.agents.get('a')?.followed ?? 0, 0)
    assert.equal(s.prompts.length, 0)
    press(s, options[0].data, 'pick-after-empty', { from })
    await s.request('editMessageText', p => p.rich_message?.html.includes('☑ Daily'))
    press(s, options.at(-1).data, 'done-after-empty', { from })
    await until(() => s.agents.get('a')?.followed === 1)
    assert.deepEqual(JSON.parse(s.agents.get('a').followups[0].content[0].text).answers[0].selected, ['Daily'])
  })
}

test('S1: callbacks fit 64 bytes for all one-to-six supported question options', async (t) => {
  const s = await startBridge(t)
  for (let count = 1; count <= 6; count += 1) {
    const title = `Choose ${count} reports`
    const after = s.calls.length
    await s.question({ ...question, question: title, options: Array.from({ length: count }, (_, index) => ({ label: `Вариант ${index + 1} ${'я'.repeat(100)}` })) })
    const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes(title), after)
    const options = buttons(sent.params.rich_message.html)
    assert.equal(options.length, count + 1)
    assert.equal(new Set(options.map(b => b.data)).size, count + 1)
    for (const option of options) {
      assert.match(option.data, /^m:[a-f0-9-]{36}:(?:[0-5]|done)$/)
      assert.ok(Buffer.byteLength(option.data) <= 64)
    }
  }
})

for (const via of ['numbers', 'computer']) {
  test(`S1: answering multi-select by ${via} settles every copy with the actual labels`, async (t) => {
    const s = await startBridge(t)
    s.message('/start', { chat: { id: 6, type: 'private' } })
    await s.request('sendMessage', p => p.chat_id === '6' && p.text === 'Hello, I am Chief.')
    await s.question(question)
    const first = await s.request('sendRichMessage', p => p.chat_id === '5' && p.rich_message.html.includes('Choose reports'))
    await s.request('sendRichMessage', p => p.chat_id === '6' && p.rich_message.html.includes('Choose reports'))
    press(s, buttons(first.params.rich_message.html)[0].data)
    await s.request('editMessageText', p => p.rich_message?.html.includes('☑ Daily'))
    const after = s.calls.length
    if (via === 'numbers') s.message('2 3')
    else {
      const data = buttons(first.params.rich_message.html)[0].data
      await s.rt.answerQuestion('a', data.slice(2, data.lastIndexOf(':')), { selected: ['Weekly', 'Monthly'] })
    }
    for (const chat of ['5', '6']) {
      const settled = await s.request('editMessageText', p => p.chat_id === chat && p.rich_message?.html.includes('type="disabled"'), after)
      assert.deepEqual(buttons(settled.params.rich_message.html).map(b => [b.label, b.data]), [['Weekly', undefined], ['Monthly', undefined]])
    }
    await until(() => s.agents.get('a')?.followed === 1)
    assert.deepEqual(JSON.parse(s.agents.get('a').followups[0].content[0].text).answers[0].selected, ['Weekly', 'Monthly'])
  })
}

test('S1: old Bot API fallback retains toggles and settles without the Done control', async (t) => {
  const s = await startBridge(t)
  s.replies.sendRichMessage = { ok: false, error_code: 404, description: 'Method not found' }
  await s.question({ ...question, options: [{ label: 'Done' }, { label: 'Later' }] })
  const sent = await s.request('sendMessage', p => p.text.includes('Choose reports'))
  const options = sent.params.reply_markup.inline_keyboard.flat()
  assert.deepEqual(options.map(b => b.text), ['☐ Done', '☐ Later', 'Done'])
  press(s, options[0].callback_data)
  const toggled = await s.request('editMessageText', p => p.reply_markup?.inline_keyboard[0]?.[0]?.text === '☑ Done')
  assert.equal(toggled.params.rich_message, undefined)
  const after = s.calls.length
  press(s, options[2].callback_data, 'legacy-done')
  const settled = await s.request('editMessageText', p => p.text?.includes('— Done'), after)
  assert.deepEqual(settled.params.reply_markup.inline_keyboard, [[{ text: 'Done', disabled: {} }]])
  await until(() => s.agents.get('a')?.followed === 1)
  assert.deepEqual(JSON.parse(s.agents.get('a').followups[0].content[0].text).answers[0].selected, ['Done'])
})

test('S1: unpaired, unsent-chat and invalid toggles cannot change a multi-select answer', async (t) => {
  const s = await startBridge(t)
  await s.question(question)
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose reports'))
  const options = buttons(sent.params.rich_message.html)
  const after = s.calls.length
  press(s, options[0].data, 'unpaired', { from: { id: 88, first_name: 'Other' } })
  press(s, options[0].data, 'unsent', { message: { message_id: 10, chat: { id: 77, type: 'private' } } })
  for (const index of ['-1', '99', '00', '1.5', 'not-an-index']) {
    press(s, options[0].data.replace(/:0$/, `:${index}`), `invalid-${index}`)
  }
  s.message('/start')
  await s.request('sendMessage', p => p.text === 'Hello, I am Chief.', after)
  assert.equal(s.calls.slice(after).some(call => call.method === 'editMessageText'), false)
  assert.equal(s.agents.get('a')?.followed ?? 0, 0)
  press(s, options.at(-1).data, 'still-empty')
  await s.request('sendMessage', p => p.text === 'Select at least one option.', after)
  assert.equal(s.prompts.length, 0)
})
