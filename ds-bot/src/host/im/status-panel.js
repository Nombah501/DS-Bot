import { randomUUID } from 'node:crypto'
import { addressKey, sameTarget } from './topics.js'

// Conservative local policy, not a documented private-widget API quota.
const UPDATE_MS = 1000
const short = value => Array.from(String(value ?? '')).slice(0, 64).join('')
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function statusData(rt, target, text, steps) {
  const sessions = target.botId !== undefined ? [rt.chatOf(target.botId)] : Object.values(rt.roomOf(target.roomId)?.sessions ?? {})
  const live = sessions.map(id => rt.live.get(id)).filter(entry => entry?.turn !== undefined)
  const waiting = sessions.some(id => rt.state.questions?.[id] !== undefined || rt.state.views?.[id] !== undefined)
    || rt.approvalsView().some(entry => target.roomId !== undefined ? entry.roomId === target.roomId : entry.botId === target.botId && entry.roomId === undefined)
    || (target.botId !== undefined && (rt.state.secretRequests?.[target.botId] ?? []).some(entry => entry.status === 'pending'))
  const since = live.map(entry => entry.since).filter(Number.isFinite)
  return {
    name: short((target.botId !== undefined ? rt.botOf(target.botId) : rt.roomOf(target.roomId))?.name),
    state: text(waiting ? 'statusWaiting' : live.length > 0 ? 'working' : 'statusIdle'),
    tool: short(live.find(entry => entry.tool !== undefined)?.tool),
    step: Math.max(0, ...sessions.map(id => steps?.get(id) ?? 0)),
    since: since.length > 0 ? Math.min(...since) : null,
    active: live.length > 0 || waiting,
  }
}

export async function showStatus(rt, { chat, target, text, steps, panels, richCards, sendCard, sendText }) {
  if (panels !== undefined && chat.kind === 'direct') {
    await panels.show(chat, target, text)
    return
  }
  const data = statusData(rt, target, text, steps)
  const body = `${data.name} — ${data.state}\n${text('statusTool')}: ${data.tool || '—'}\n${text('statusStep')}: ${data.step}\n${text('statusElapsed')}: ${data.since === null ? 0 : Math.max(0, Math.floor((Date.now() - data.since) / 1000))} s`
  if (chat.kind === 'group' && data.active && richCards && sendCard !== undefined) {
    const key = `t:${randomUUID()}`
    await sendCard(key, [{ chat, target }], body, undefined,
      () => ({ text: body, options: [{ data: `${key}:stop`, label: text('stop') }] }))
  } else {
    sendText(body)
  }
}

// Original, self-contained TelegramWidget document; native styles follow the chat theme.
export function statusHtml(text) {
  const labels = JSON.stringify({ stop: text('stop'), sending: text('statusSending'), failed: text('statusFailed') }).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui}h3,p{overflow-wrap:anywhere}button{min-height:44px;width:100%}small{color:var(--tg-theme-hint-color)}
</style></head><body><h3 id="name"></h3><p id="state"></p><p>${escape(text('statusTool'))}: <span id="tool"></span><br>${escape(text('statusStep'))}: <span id="step"></span><br>${escape(text('statusElapsed'))}: <span id="elapsed"></span></p><button id="stop">${escape(text('stop'))}</button><small id="notice"></small><script>
const W=TelegramWidget,L=${labels},get=id=>document.getElementById(id);let data={},pending=false;
function elapsed(){const seconds=data.since===null?0:Math.max(0,Math.floor((Date.now()-data.since)/1000));get('elapsed').textContent=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')}
function render(){data=JSON.parse(W.chatData||'{}');for(const key of ['name','state','step'])get(key).textContent=data[key]??'';get('tool').textContent=data.tool||'—';get('stop').disabled=pending||!data.active;elapsed()}
get('stop').addEventListener('click',()=>{pending=true;get('stop').disabled=true;get('notice').textContent=L.sending;W.request('stop').then(()=>{get('notice').textContent=''},error=>{get('notice').textContent=L.failed+' ('+error.code+')'}).finally(()=>{pending=false;render()})});
W.onEvent('chatDataChanged',render);render();setInterval(elapsed,1000);W.ready();
</script></body></html>`
}

export function statusPanels(handle, { rt, steps, records, textForChat, deliverable, save, warn, recover }) {
  const snapshot = record => statusData(rt, record.target, textForChat(record.chat), steps)
  const valid = record => deliverable(record.chat, record.target)
    && (record.target.botId !== undefined ? rt.botOf(record.target.botId) : rt.roomOf(record.target.roomId)) !== undefined
  const inFlight = new Set()
  const last = new Map()
  let stopped = false
  const send = async (record, text = textForChat(record.chat)) => {
    const data = snapshot(record)
    const content = { html: statusHtml(text), data: JSON.stringify(data), caption: `${text('statusPanel')}: ${data.name} — ${data.state}` }
    let sent
    try {
      sent = await handle.sendStatusPanel(record.chat, content)
    } catch (error) {
      if (error?.topicMissing !== true || !await recover(record.chat) || stopped || !valid(record)) throw error
      sent = await handle.sendStatusPanel(record.chat, content)
    }
    record.messageId = sent.messageId
    record.data = content.data
  }
  // The widget is the panel once Telegram has it, so it is recorded before the pin:
  // a pin that fails, or a shutdown that cuts it off, must not cost the next /status
  // a second panel.
  const pin = async record => {
    try { await handle.pinStatusPanel?.(record.chat, record.messageId) } catch (error) { warn(error) }
  }
  const refresh = async record => {
    if (stopped || !valid(record) || inFlight.has(record) || Date.now() < (last.get(record) ?? 0)) return
    const data = JSON.stringify(snapshot(record))
    if (data === record.data && record.messageId !== undefined) return
    inFlight.add(record)
    last.set(record, Date.now() + UPDATE_MS)
    try {
      if (record.messageId === undefined) {
        await send(record)
        save()
        await pin(record)
      } else {
        await handle.editStatusPanel(record.chat, record.messageId, data)
        record.data = data
        save()
      }
    } catch (error) {
      if (error.retryAfter !== undefined) last.set(record, Date.now() + Math.max(UPDATE_MS, Number(error.retryAfter) * 1000))
      warn(error)
    } finally { inFlight.delete(record) }
  }
  const timer = setInterval(() => { for (const record of records) void refresh(record) }, UPDATE_MS)
  timer.unref?.()
  return {
    async show(chat, target, text) {
      const existing = records.find(record => addressKey(record.chat) === addressKey(chat) && sameTarget(record.target, target))
      if (existing !== undefined) { await refresh(existing); return }
      const record = { chat, target }
      await send(record, text)
      if (stopped || !valid(record)) return
      records.push(record)
      last.set(record, Date.now() + UPDATE_MS)
      save()
      await pin(record)
    },
    find(chatKey, messageId) { return records.find(record => record.chat.key === chatKey && record.messageId === messageId && valid(record)) },
    stop() { stopped = true; clearInterval(timer) },
  }
}
