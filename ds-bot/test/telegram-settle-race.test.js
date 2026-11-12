import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridge, until } from './telegram-bridge.js'

const buttons = html => [...html.matchAll(/<tg-button\s+([^>]*)>(.*?)<\/tg-button>/gs)].map(([, attrs, label]) => ({ attrs, label }))

test('S1: a save during question delivery preserves the selected settled option', async (t) => {
  const s = await startBridge(t)
  s.rt.state.views.a = { id: 'save-marker', title: 'Save marker', view: {} }
  await s.rt.save()
  await s.request('sendMessage', p => p.text.includes('Save marker'))
  await s.question({ question: 'Choose a period', options: [{ label: 'Daily' }, { label: 'Weekly' }] })
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Choose a period'))
  const id = /data="q:([^"]+):0"/.exec(sent.params.rich_message.html)[1]
  const gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  let flushing = false
  s.ctx.sessions.flush = () => { flushing = true; return gate.promise }
  const answering = s.rt.answerQuestion('a', id, { selected: ['Weekly'] })
  await until(() => flushing)
  delete s.rt.state.views.a
  await s.rt.save()
  // The marker edit proves onSaved reached settleGone before delivery resumes.
  await s.request('editMessageText', p => p.text?.includes('Save marker'))
  gate.resolve()
  await answering
  const edited = await s.request('editMessageText', p => p.rich_message?.html.includes('Choose a period'))
  const html = edited.params.rich_message.html
  assert.deepEqual(buttons(html).map(option => option.label), ['Weekly'])
  assert.match(buttons(html)[0].attrs, /type="disabled"/)
  assert.match(html, /— Weekly/)
})

test('S1: failed question delivery reopens copies already edited by a concurrent save', async (t) => {
  const s = await startBridge(t)
  s.rt.state.views.a = { id: 'rollback-marker', title: 'Rollback marker', view: {} }
  await s.rt.save()
  await s.request('sendMessage', p => p.text.includes('Rollback marker'))
  await s.question({ question: 'Retry period', options: [{ label: 'Daily' }, { label: 'Weekly' }] })
  const sent = await s.request('sendRichMessage', p => p.rich_message.html.includes('Retry period'))
  const id = /data="q:([^"]+):0"/.exec(sent.params.rich_message.html)[1]
  const gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  let flushing = false
  s.ctx.sessions.flush = () => { flushing = true; return gate.promise }
  const answering = assert.rejects(s.rt.answerQuestion('a', id, { selected: ['Weekly'] }), /Delivery failed/)
  await until(() => flushing)
  delete s.rt.state.views.a
  await s.rt.save()
  await s.request('editMessageText', p => p.text?.includes('Rollback marker'))
  await s.request('editMessageText', p => p.rich_message?.html.includes('Retry period'))
  const after = s.calls.length
  gate.reject(new Error('Delivery failed'))
  await answering
  const reopened = await s.request('editMessageText', p => p.rich_message?.html.includes('Retry period'), after)
  assert.deepEqual(buttons(reopened.params.rich_message.html).map(option => option.label), ['Daily', 'Weekly'])
  assert.match(buttons(reopened.params.rich_message.html)[0].attrs, /type="callback_data"/)
  assert.equal(s.rt.state.questions.a.id, id)
  s.ctx.sessions.flush = async () => {}
  await s.rt.answerQuestion('a', id, { selected: ['Daily'] })
  const settled = await s.request('editMessageText', p => p.rich_message?.html.includes('— Daily'), after)
  assert.deepEqual(buttons(settled.params.rich_message.html).map(option => option.label), ['Daily'])
})

test('S1: approval settlement claims every connection before the first edit awaits', async (t) => {
  const gate = Promise.withResolvers()
  const editing = Promise.withResolvers()
  const fetch = globalThis.fetch
  let block = true
  t.after(() => gate.resolve())
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/editMessageText') && block) {
      block = false
      editing.resolve()
      await gate.promise
    }
    return fetch(url, options)
  })
  const s = await startBridge(t)
  const second = await s.rt.imEndpoint('im-add', { platform: 'telegram', botId: 'a', fields: { token: 'S1-SECOND-FAKE-TOKEN' } })
  const conn = s.rt.state.im.connections[second.id]
  const first = s.rt.state.im.connections[s.connection.id]
  conn.paired = structuredClone(first.paired)
  conn.chats = { 6: structuredClone(first.chats['5']) }
  s.rt.state.views.a = { id: 'approval-marker', title: 'Approval marker', view: {} }
  await s.rt.save()
  await s.request('sendMessage', p => p.chat_id === '6' && p.text.includes('Approval marker'))
  const outcome = s.approval({ agent: s.agentOf('a'), toolName: 'bash', reason: 'Concurrent approval' })
  await s.request('sendRichMessage', p => p.chat_id === '5' && p.rich_message.html.includes('Concurrent approval'))
  await s.request('sendRichMessage', p => p.chat_id === '6' && p.rich_message.html.includes('Concurrent approval'))
  s.rt.answerApproval(s.rt.approvalsView()[0].id, 'reject')
  await editing.promise
  delete s.rt.state.views.a
  await s.rt.save()
  await s.request('editMessageText', p => p.chat_id === '6' && p.text?.includes('Approval marker'))
  gate.resolve()
  assert.deepEqual(await outcome, ['rejected'])
  for (const chatId of ['5', '6']) {
    const edited = await s.request('editMessageText', p => p.chat_id === chatId && p.rich_message?.html.includes('Concurrent approval'))
    assert.deepEqual(buttons(edited.params.rich_message.html).map(option => option.label), ['Reject'])
    assert.match(buttons(edited.params.rich_message.html)[0].attrs, /type="disabled" style="danger"/)
  }
})
