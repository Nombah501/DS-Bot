import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge } from './telegram-bridge.js'

for (const [language, greeting] of [['ru', 'Здравствуйте, я Chief.'], ['ru-RU', 'Здравствуйте, я Chief.'], ['de', 'Hello, I am Chief.'], [undefined, 'Hello, I am Chief.']]) {
  test(`S1: Bridge greeting follows Telegram sender language ${language}`, async (t) => {
    const s = await startBridge(t)
    s.message('/start', { from: { id: 9, first_name: 'Ann', language_code: language } })
    const sent = await s.request('sendMessage', p => p.text === greeting)
    assert.equal(sent.params.chat_id, '5')
  })
}

test('S1: Russian pairing, cards, Stop and callback notices follow the sender', async (t) => {
  const s = await startBridge(t, { pair: false })
  const from = { id: 9, first_name: 'Ann', language_code: 'ru' }
  s.message('/start', { from })
  await s.request('sendMessage', p => p.text.startsWith('Запрос на подключение'))
  await s.rt.imEndpoint('im-pair', { id: s.connection.id, senderId: '9', allow: true })
  await s.request('sendMessage', p => p.text === 'Подключено — теперь можно общаться с Chief.')
  s.message('/stop', { from })
  await s.request('sendMessage', p => p.text === 'Сейчас ничего не выполняется.')
  await s.question({ question: 'Which report?', options: [{ label: 'Daily' }] })
  const card = await s.request('sendRichMessage', p => p.rich_message.html.includes('Chief спрашивает: '))
  assert.match(card.params.rich_message.html, /ответьте номером/)
  s.pushUpdate({ callback_query: { id: 'stale-ru', from, data: 'q:missing:0', message: { message_id: 10, chat: { id: 5, type: 'private' } } } })
  await s.request('answerCallbackQuery', p => p.callback_query_id === 'stale-ru' && p.text === 'На эту карточку уже ответили.')
  const controller = new AbortController()
  t.after(() => controller.abort())
  const outcome = s.approval({ agent: s.agentOf('a'), toolName: 'bash', reason: 'Inspect report', signal: controller.signal })
  const approval = await s.request('sendRichMessage', p => p.rich_message.html.includes('Chief запрашивает разрешение: '))
  assert.match(approval.params.rich_message.html, />Разрешить один раз<\/tg-button>/)
  const allow = /data="([^"]+:allow)"/.exec(approval.params.rich_message.html)[1]
  s.pushUpdate({ callback_query: { id: 'allow-ru', from, data: allow, message: { message_id: 11, chat: { id: 5, type: 'private' } } } })
  assert.deepEqual(await outcome, ['allowed-once'])
  await s.request('editMessageText', p => p.rich_message?.html.includes('— Разрешить один раз'))
  s.message('/start', { from: { ...from, language_code: 'en' } })
  await s.request('sendMessage', p => p.text === 'Hello, I am Chief.')
})
