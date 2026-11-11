import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge } from './telegram-bridge.js'

const press = (s, data, id, language = 'en') => s.pushUpdate({ callback_query: {
  id, from: { id: 9, first_name: 'Ann', language_code: language }, data,
  message: { message_id: 10, chat: { id: 5, type: 'private' } },
} })
const question = { question: 'Choose reports', multiSelect: true, options: [{ label: 'Daily' }, { label: 'Weekly' }] }

test('S1: empty Done answers only its callback with a localized toast', async t => {
  const s = await startBridge(t)
  await s.question(question)
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose reports'))
  const done = /data="([^"]*:done)"/.exec(sent.params.rich_message.html)[1]
  const after = s.calls.length
  press(s, done, 'empty')
  const answer = await s.request('answerCallbackQuery', p => p.callback_query_id === 'empty')
  assert.equal(answer.params.text, 'Select at least one option.')
  s.message('/start')
  await s.request('sendMessage', p => p.text === 'Hello, I am Chief.', after)
  assert.equal(s.calls.slice(after).some(c => c.method === 'sendMessage' && c.params.text === 'Select at least one option.'), false)
  assert.equal(s.calls.filter(c => c.method === 'answerCallbackQuery' && c.params.callback_query_id === 'empty').length, 1)
  assert.equal(s.agents.get('a')?.followed ?? 0, 0)
})

for (const [language, locale, notice, stale] of [
  ['ru-RU', 'en', 'Выберите хотя бы один вариант.', 'На эту карточку уже ответили.'],
  ['de', 'en', 'Select at least one option.', 'This card was already answered.'],
  ['zh-CN', 'zh-CN', '请至少选择一个选项。', '这张卡已经答过了。'],
]) {
  test(`S1: callback notices use the pressing person's ${language} locale`, async t => {
    const s = await startBridge(t, { locale })
    await s.question(question)
    const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose reports'))
    const done = /data="([^"]*:done)"/.exec(sent.params.rich_message.html)[1]
    const after = s.calls.length
    press(s, done, 'localized-empty', language)
    const empty = await s.request('answerCallbackQuery', p => p.callback_query_id === 'localized-empty')
    assert.equal(empty.params.text, notice)
    press(s, 'q:missing:0', 'localized-stale', language)
    const answered = await s.request('answerCallbackQuery', p => p.callback_query_id === 'localized-stale')
    assert.equal(answered.params.text, stale)
    assert.equal(s.calls.slice(after).some(c => c.method === 'sendMessage'), false)
  })
}

test('S1: ordinary and ignored presses each receive exactly one callback answer', async t => {
  const s = await startBridge(t)
  await s.question(question)
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose reports'))
  const toggle = /data="([^"]*:0)"/.exec(sent.params.rich_message.html)[1]
  const after = s.calls.length
  press(s, toggle, 'ordinary')
  await s.request('editMessageText', p => p.rich_message?.html.includes('☑ Daily'), after)
  await s.request('answerCallbackQuery', p => p.callback_query_id === 'ordinary')
  s.pushUpdate({ callback_query: { id: 'unpaired', from: { id: 88 }, data: toggle, message: { message_id: 10, chat: { id: 5, type: 'private' } } } })
  await s.request('answerCallbackQuery', p => p.callback_query_id === 'unpaired')
  s.message('/start')
  await s.request('sendMessage', p => p.text === 'Hello, I am Chief.', after)
  for (const id of ['ordinary', 'unpaired']) {
    const answers = s.calls.filter(c => c.method === 'answerCallbackQuery' && c.params.callback_query_id === id)
    assert.deepEqual(answers.map(c => c.params), [{ callback_query_id: id }])
  }
  assert.equal(s.agents.get('a')?.followed ?? 0, 0)
})

for (const [language, locale, notice] of [
  ['en', 'en', 'This Bot or group is not on your Access list.'],
  ['ru-RU', 'en', 'Этот Bot или группа не входят в ваш список доступа.'],
  ['zh-CN', 'zh-CN', '此 Bot 或群组不在你的访问列表中。'],
]) {
  test(`S1: access refusal is a private callback toast in ${language}`, async t => {
    const s = await startBridge(t, { locale })
    await s.question(question)
    const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose reports'))
    const toggle = /data="([^"]*:0)"/.exec(sent.params.rich_message.html)[1]
    await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: [], roomIds: [] } })
    const after = s.calls.length
    press(s, toggle, 'denied', language)
    const answer = await s.request('answerCallbackQuery', p => p.callback_query_id === 'denied')
    assert.equal(answer.params.text, notice)
    assert.equal(s.calls.slice(after).some(c => c.method === 'sendMessage'), false)
    assert.equal(s.agents.get('a')?.followed ?? 0, 0)
  })
}

for (const failure of ['slow', 'throw']) {
  test(`S1: a ${failure} DSH answer cannot leave a callback spinner waiting`, async t => {
    const s = await startBridge(t)
    await s.question({ question: 'Continue?', options: [{ label: 'Yes' }] })
    const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Continue?'))
    const data = /data="([^"]+)"/.exec(sent.params.rich_message.html)[1]
    let release
    const flush = new Promise(resolve => { release = resolve })
    t.after(() => release())
    s.ctx.sessions.flush = () => {
      if (failure === 'throw') throw new Error('DSH flush failed')
      return flush
    }
    const after = s.calls.length
    press(s, data, failure)
    const answer = await s.request('answerCallbackQuery', p => p.callback_query_id === failure)
    assert.deepEqual(answer.params, { callback_query_id: failure })
    assert.equal(s.agents.get('a').followed, 1)
    release()
    s.message('/start')
    await s.request('sendMessage', p => p.text === 'Hello, I am Chief.', after)
    assert.equal(s.calls.filter(c => c.method === 'answerCallbackQuery' && c.params.callback_query_id === failure).length, 1)
  })
}

test('S1: /lang overrides device and browser languages for empty Done and access toasts', async t => {
  const s = await startBridge(t, { locale: 'zh-CN' })
  await s.question(question)
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose reports'))
  const done = /data="([^"]*:done)"/.exec(sent.params.rich_message.html)[1]
  for (const [preference, device, confirmation, notice, denied] of [
    ['en', 'ru', 'Language: en.', 'Select at least one option.', 'This Bot or group is not on your Access list.'],
    ['ru', 'en', 'Язык: ru.', 'Выберите хотя бы один вариант.', 'Этот Bot или группа не входят в ваш список доступа.'],
  ]) {
    await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: 'all' })
    const after = s.calls.length
    s.message(`/lang ${preference}`, { from: { id: 9, language_code: device } })
    await s.request('sendMessage', p => p.text.startsWith(confirmation), after)
    const callbackStart = s.calls.length
    press(s, done, `preference-${preference}`, device)
    await s.request('answerCallbackQuery', p => p.callback_query_id === `preference-${preference}` && p.text === notice)
    await s.rt.imEndpoint('im-access', { id: s.connection.id, senderId: '9', access: { botIds: [], roomIds: [] } })
    press(s, done, `preference-denied-${preference}`, device)
    await s.request('answerCallbackQuery', p => p.callback_query_id === `preference-denied-${preference}` && p.text === denied)
    assert.equal(s.calls.slice(callbackStart).some(c => c.method === 'sendMessage'), false)
  }
})
