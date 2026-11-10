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

export function statusPanels(handle, { records, snapshot, valid, save, warn }) {
  const inFlight = new Set()
  const last = new Map()
  let stopped = false
  const refresh = async record => {
    if (stopped || !valid(record) || inFlight.has(record) || Date.now() < (last.get(record) ?? 0)) return
    const data = JSON.stringify(snapshot(record))
    if (data === record.data) return
    inFlight.add(record)
    last.set(record, Date.now() + UPDATE_MS)
    try {
      await handle.editStatusPanel(record.chat, record.messageId, data)
      record.data = data
      save()
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
      record.data = JSON.stringify(snapshot(record))
      const sent = await handle.sendStatusPanel(chat, { html: statusHtml(text), data: record.data, caption: `${text('statusPanel')}: ${snapshot(record).name} — ${snapshot(record).state}` })
      record.messageId = sent.messageId
      if (stopped || !valid(record)) return
      records.push(record)
      last.set(record, Date.now() + UPDATE_MS)
      save()
    },
    find(chatKey, messageId) { return records.find(record => record.chat.key === chatKey && record.messageId === messageId && valid(record)) },
    stop() { stopped = true; clearInterval(timer) },
  }
}
