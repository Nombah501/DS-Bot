import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge } from './telegram-bridge.js'

test('S1: a step renders a rich table with escaped pipes and inline formatting', async t => {
  const s = await startBridge(t)
  s.step('# Report\n\n| Name | Value |\n| --- | --- |\n| a\\|b | **yes** |')
  const sent = await s.request('sendRichMessage')
  assert.match(sent.params.rich_message.html, /<th>Name<\/th>/)
  assert.match(sent.params.rich_message.html, /<td>a\|b<\/td><td><b>yes<\/b><\/td>/)
  assert.match(sent.params.rich_message.html, /<h1>Report<\/h1>/)
})

test('S1: long Unicode steps split without losing characters or bisecting table rows', async t => {
  const s = await startBridge(t)
  const body = '😀'.repeat(32768)
  s.step(`${body}\n\n| Key | Value |\n| --- | --- |\n| last | intact |`)
  await s.request('sendRichMessage', params => params.rich_message.html.includes('<td>last</td>'))
  const html = s.calls.filter(call => call.method === 'sendRichMessage').map(call => call.params.rich_message.html)
  assert.equal(html.length, 2)
  assert.equal(Array.from(html[0].replace(/<[^>]*>/g, '')).length, 32768)
  assert.equal((html.join('').match(/😀/gu) ?? []).length, 32768)
  assert.match(html[1], /<tr><td>last<\/td><td>intact<\/td><\/tr>/)
})

test('S1: unknown rich method alone falls back to HTML', async t => {
  const s = await startBridge(t)
  s.replies.sendRichMessage = { ok: false, error_code: 404, description: 'Method not found' }
  const after = s.calls.length
  s.step('**Fallback**')
  const sent = await s.request('sendMessage', params => params.text === '<b>Fallback</b>', after)
  assert.equal(sent.params.parse_mode, 'HTML')
})

test('S1: an oversized table row keeps every cell as split rich text', async t => {
  const s = await startBridge(t)
  s.step(`| Key | Value |\n| --- | --- |\n| huge | ${'x'.repeat(33000)} |`)
  await s.request('sendRichMessage', params => params.rich_message.html.includes('x'.repeat(200)) && !params.rich_message.html.includes('x'.repeat(1000)))
  const html = s.calls.filter(call => call.method === 'sendRichMessage').map(call => call.params.rich_message.html).join('')
  assert.equal((html.match(/x/g) ?? []).length, 33000)
  assert.match(html, /Key: huge/)
  assert.match(html, /Value:/)
})

test('S1: DS Bot room lines use the same rich path', async t => {
  const s = await startBridge(t, { seed: {
    version: 1, mainBotIds: ['a'], bots: { a: { id: 'a', name: 'Chief', sessionId: 'a', createdAt: 1 } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a'], mode: 'everyone', admin: 'a', named: true, log: [], seq: 0 } },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  } })
  await s.rt.imEndpoint('im-chat', { id: s.connection.id, chatKey: '5', target: { roomId: 'r1' } })
  s.rt.logRoom(s.rt.roomOf('r1'), { who: 'Chief', botId: 'a', text: 'Room **report**' })
  const sent = await s.request('sendRichMessage')
  assert.equal(sent.params.rich_message.html, '<p><b>Chief</b>: Room <b>report</b></p>')
})

test('S1: fenced code counts Markdown markers literally against the rich message limit', async t => {
  const s = await startBridge(t)
  const code = '**literal**\n'.repeat(3000)
  s.step(`\`\`\`md\n${code}\`\`\``)
  await s.request('sendRichMessage', p => p.rich_message.html.includes('literal') && p.rich_message.html.length < 5000)
  const html = s.calls.filter(c => c.method === 'sendRichMessage').map(c => c.params.rich_message.html)
  assert.equal(html.length, 2)
  const bodies = html.map(value => /^<pre><code class="language-md">([\s\S]*)<\/code><\/pre>$/.exec(value)[1])
  assert.ok(bodies.every(value => Array.from(value).length <= 32768))
  assert.equal(bodies.join(''), code.trimEnd())
})

test('S1: consecutive numbered items share an ordered list with their original start', async t => {
  const s = await startBridge(t)
  s.step('3. Third\n4. Fourth\n\n8. Eighth\n9. Ninth')
  const sent = await s.request('sendRichMessage')
  assert.equal(sent.params.rich_message.html, '<ol start="3"><li>Third</li><li>Fourth</li></ol>\n<ol start="8"><li>Eighth</li><li>Ninth</li></ol>')
})

test('S1: a header-only Markdown table still reaches Telegram', async t => {
  const s = await startBridge(t)
  s.step('| Name | Value |\n| --- | --- |')
  const sent = await s.request('sendRichMessage')
  assert.equal(sent.params.rich_message.html, '<table><tr><th>Name</th><th>Value</th></tr></table>')
})
