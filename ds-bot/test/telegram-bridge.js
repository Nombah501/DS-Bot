// S1 composes im.test.js's fake DSH context with im-telegram.test.js's HTTP seam.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

export async function until(read, timeout = 3000) {
  const deadline = performance.now() + timeout
  do {
    const value = await read()
    if (value !== undefined && value !== false) return value
    await delay(10)
  } while (performance.now() < deadline)
  throw new Error('Timed out waiting for Bridge boundary output')
}

export async function startBridge(t, { seed, getMe = { id: 7, username: 'fakebot', is_bot: true }, pair = true, existingConnectionId } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-s1-'))
  const calls = []
  const updates = []
  const replies = {}
  const polls = new Set()
  let updateId = 0
  let messageId = 0
  const respond = (res, answer) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer))
  }
  const drain = () => {
    if (updates.length === 0 || polls.size === 0) return
    const res = polls.values().next().value
    polls.delete(res)
    respond(res, { ok: true, result: updates.splice(0) })
  }
  const server = createServer((req, res) => {
    req.setEncoding('utf8')
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const method = new URL(req.url, 'http://localhost').pathname.split('/').at(-1)
      const params = JSON.parse(body || '{}')
      calls.push({ method, params })
      const override = replies[method]
      if (override !== undefined) {
        respond(res, typeof override === 'function' ? override(params) : override)
      } else if (method === 'getUpdates') {
        polls.add(res)
        res.on('close', () => polls.delete(res))
        drain()
      } else if (method === 'createForumTopic') {
        respond(res, { ok: true, result: { message_thread_id: ++messageId, name: params.name } })
      } else {
        respond(res, { ok: true, result: method === 'getMe' ? getMe : { message_id: ++messageId, chat: { id: params.chat_id } } })
      }
    })
  })
  let ctx
  t.after(async () => {
    try { await ctx?.dispose() } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed ?? {
    version: 1, mainBotIds: ['a'],
    bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  const prompts = []
  const agents = new Map()
  const agentOf = id => {
    if (!agents.has(id)) agents.set(id, {
      id, session: { id, requestHeader: () => undefined },
      followup(message) {
        this.followed = (this.followed ?? 0) + 1
        this.followups ??= []
        this.followups.push(message)
      },
      cancel() { this.cancelled = true },
      inbox: { nextStep: [], nextTurn: [], remove: () => false },
      async whenIdle() {},
    })
    return agents.get(id)
  }
  const context = () => Object.assign(fakeContext(), {
    llm: { listProviders: () => [] },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
    sessionController: {
      prompt: async request => { prompts.push(request); return { ok: true } },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {},
    },
    sessions: { flush: async () => {} },
  })
  const boot = () => createRuntime(ctx = context(), { home, im: { telegram: { api: `http://127.0.0.1:${server.address().port}` } } })
  let rt = boot()
  const request = (method, predicate = () => true, after = 0) => until(() => calls.slice(after).find(call => call.method === method && predicate(call.params)))
  const pushUpdate = update => {
    updates.push({ update_id: ++updateId, ...update })
    drain()
  }
  const message = (text, extra = {}) => pushUpdate({ message: {
    message_id: ++messageId, chat: { id: 5, type: 'private' },
    from: { id: 9, first_name: 'Ann', username: 'ann', language_code: 'en' }, text, ...extra,
  } })
  let seq = 0
  const sessionEvent = (type, data, sessionId = 'a') => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: sessionId }, { type, data, seq: ++seq, time: Date.now() })
    }
  }
  await rt.load()
  const connection = existingConnectionId === undefined
    ? await rt.imEndpoint('im-add', { platform: 'telegram', botId: 'a', fields: { token: 'S1-FAKE-TOKEN' } })
    : rt.imView().connections.find(conn => conn.id === existingConnectionId)
  if (existingConnectionId !== undefined) await rt.imEndpoint('im-retry', { id: existingConnectionId })
  await request('getUpdates')
  if (pair) {
    message('hello')
    await request('sendMessage', params => /connection request/.test(params.text))
    await rt.imEndpoint('im-pair', { id: connection.id, senderId: '9', allow: true })
    await request('sendMessage', params => /talk to Chief/.test(params.text))
  }
  return {
    get ctx() { return ctx }, get rt() { return rt }, home, calls, replies, prompts, agents, agentOf, connection, request, pushUpdate, message, sessionEvent,
    restart: async () => {
      await ctx.dispose()
      rt = boot()
      await rt.load()
      await rt.imEndpoint('im-retry', { id: connection.id })
    },
    step: (text, data = {}, sessionId = 'a') => sessionEvent('assistant/message', { message: { content: [{ type: 'text', text }] }, ...data }, sessionId),
    assistantStream: (frame, sessionId = 'a') => ctx.emit('agent/assistant-stream', { agent: agentOf(sessionId), frame }),
    approval: (request, next = () => new Promise(() => {})) => Promise.all((ctx.listeners.get('approval/request') ?? []).map(listener => listener(request, next))),
    question: (question, sessionId = 'a', callId = 's1-question') => rt.teamTools.find(tool => tool.name === 'ask_user').execute(question, { agent: { id: sessionId }, callId, concludeTurn() {} }),
  }
}
