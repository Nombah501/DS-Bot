// Delivery schedules one runner's sends; its connection-owned state keeps Retained
// sends and interrupted work alive across adapter replacement.
import { imPlatform } from '../../shared/im-platforms.js'
import { addressKey } from './topics.js'
import { classify, recoverMissingTopic } from './errors.js'

const RETRY_MS = 5_000
const RETRY_MAX_MS = 30_000
const SEND_ATTEMPTS = 4

export function delivery({ connection, placement, sending = () => undefined, recoverTopic, setStatus, warn, state = { queues: new Map() } }) {
  const queues = state.queues
  const inFlight = new Set()
  let handle
  let closed = false
  const owner = { drain: (key, queue) => drain(key, queue), closed: false }
  state.current = owner
  const expired = job => job.content.receiverUserId !== undefined && Date.now() >= job.content.privateUntil
  const status = (key, queue, next) => {
    if (next === undefined && queue.status === undefined) return
    queue.status = next
    if (!state.forgotten) setStatus(key, next)
  }
  const clearStatus = (key, queue) => {
    if (queue.retained.length === 0 && queue.jobs.length === 0) status(key, queue, undefined)
  }
  const finish = (queue, job, receipt) => {
    const index = queue.jobs.indexOf(job)
    if (index !== -1) queue.jobs.splice(index, 1)
    job.resolve(receipt)
  }
  const drop = async (key, queue, job, reason) => {
    finish(queue, job)
    try { if (!state.forgotten && connection() !== undefined) await job.dropped?.(reason) }
    catch (error) { warn('ds-bot: im delivery drop failed: %s', error) }
    clearStatus(key, queue)
  }
  const retain = (key, queue, job, error, before) => {
    finish(queue, job)
    const index = before === undefined ? -1 : queue.retained.indexOf(before)
    if (index === -1) queue.retained.push(job)
    else queue.retained.splice(index, 0, job)
    status(key, queue, { state: 'error', error })
  }
  // Close waits only for wire attempts and their receipts, never uncancellable
  // Draft waits or Topic recovery. Register before calling into the adapter.
  const send = async (conn, job) => {
    let done
    const pending = new Promise(resolve => { done = resolve })
    inFlight.add(pending)
    job.onWire = true
    try {
      const content = { ...job.content }
      if (content.rich !== true || imPlatform(conn.platform)?.richMessages !== true) delete content.rich
      const receipt = content.receiverUserId !== undefined && imPlatform(conn.platform)?.privateCards === true
        ? await handle.sendPrivateCard(job.chat, content.receiverUserId, content.card)
        : content.card !== undefined && imPlatform(conn.platform)?.richCards === true
          ? await handle.sendCard(job.chat, content.card)
          : await handle.send(job.chat, content)
      // A successful wire attempt is final, even if saving its receipt fails.
      try { if (!state.forgotten && connection() !== undefined) await job.sent?.(receipt, { ...job.chat }) }
      catch (error) { warn('ds-bot: im delivery receipt failed: %s', error) }
      return receipt
    } finally {
      job.onWire = false
      inFlight.delete(pending)
      done()
    }
  }
  const drain = async (key, queue) => {
    if (closed || state.forgotten || handle === undefined || queue.busy || queue.retry !== undefined) return
    queue.busy = owner
    try {
      while (!closed && queue.jobs.length > 0) {
        const job = queue.jobs[0]
        if (expired(job)) {
          await drop(key, queue, job, 'expired')
          continue
        }
        try {
          if (job.draft !== undefined) await job.draft
          if (closed) return
          const draft = sending(key)
          if (draft !== undefined) {
            job.draft = draft
            await draft
          }
          if (closed) return
          job.draft = undefined
          const conn = connection()
          if (conn === undefined || expired(job)) {
            await drop(key, queue, job, 'placement')
            continue
          }
          placement.follow(conn, job.chat)
          if (!placement.deliverable(conn, job.chat, job.place)) {
            await drop(key, queue, job, 'placement')
            continue
          }
          const receipt = await send(conn, job)
          finish(queue, job, receipt)
          clearStatus(key, queue)
        } catch (caught) {
          let error = caught
          if (!closed && imPlatform(connection()?.platform)?.topics === true && !job.topicRecovered && error?.topicMissing === true) {
            job.topicRecovered = true
            try {
              const recovered = await recoverMissingTopic(error, job.chat, recoverTopic)
              if (closed) return
              if (recovered) continue
            } catch (recoveryError) { error = recoveryError }
          }
          const { kind, retryAfterMs } = classify(error, { topicRecovery: false })
          if (state.forgotten || connection() === undefined || kind === 'drop') {
            await drop(key, queue, job, 'adapter')
            continue
          }
          if (closed) {
            // A replay may already be waiting for this wire attempt. Keep its
            // head in front of the followers; otherwise retain it before them.
            if (job.resume !== state.current || state.current.closed) {
              retain(key, queue, job, String(error?.message ?? error).slice(0, 300), job.beforeRetained)
            }
            return
          }
          const message = String(error?.message ?? error).slice(0, 300)
          if (kind === 'retry' && ++job.attempts < SEND_ATTEMPTS) {
            const backoff = Math.min(RETRY_MS * 2 ** (job.attempts - 1), RETRY_MAX_MS)
            status(key, queue, { state: 'retrying', error: message })
            queue.retry = setTimeout(() => {
              queue.retry = undefined
              void drain(key, queue)
            }, retryAfterMs > 0 ? retryAfterMs : backoff)
            queue.retry.unref?.()
            return
          }
          const failure = kind === 'retry' ? `Send failed after ${job.attempts} attempts: ${message}` : message
          retain(key, queue, job, failure)
          warn('ds-bot: im send failed: %s', failure)
        }
      }
    } finally {
      if (queue.busy === owner) queue.busy = false
      if (queues.get(key) === queue) {
        if (queue.jobs.length === 0 && queue.retained.length === 0) queues.delete(key)
        else if (closed && state.current !== owner) void state.current.drain(key, queue)
      }
    }
  }
  const enqueue = (place, content, { sent, dropped } = {}) => {
    if (closed || state.forgotten) return Promise.resolve()
    const key = addressKey(place.chat)
    let queue = queues.get(key)
    if (queue === undefined) queues.set(key, queue = { jobs: [], retained: [], busy: false })
    return new Promise(resolve => {
      queue.jobs.push({ place, chat: { ...place.chat }, content: { ...content }, sent, dropped, resolve, attempts: 0 })
      void drain(key, queue)
    })
  }
  return {
    /** A complete Placement place; target-only places are bound snapshots. */
    output(place, content, options) {
      const target = place?.target
      if (typeof place?.chat?.key !== 'string' || target === null || typeof target !== 'object'
        || !((typeof target.botId === 'string' && target.botId !== '' && target.roomId === undefined)
          || (typeof target.roomId === 'string' && target.roomId !== '' && target.botId === undefined))) {
        throw new TypeError('Delivery output requires a Placement place with a target')
      }
      return enqueue(structuredClone(place), content, options)
    },
    /** Bridge notices and control Cards deliberately have no Bot binding. */
    notice: (chat, content, options) => enqueue({ chat }, content, options),
    attach(next) {
      if (closed) return
      handle = next
      for (const [key, queue] of queues) void drain(key, queue)
    },
    retry() {
      if (closed || state.forgotten) return
      for (const [key, queue] of queues) {
        clearTimeout(queue.retry)
        queue.retry = undefined
        const pending = queue.jobs[0]?.onWire ? queue.jobs.shift() : undefined
        queue.jobs.unshift(...queue.retained.splice(0))
        if (pending !== undefined) queue.jobs.unshift(pending)
        for (const job of queue.jobs) { job.attempts = 0; job.resume = owner }
        if (queue.jobs.length > 0) status(key, queue, { state: 'retrying' })
        void drain(key, queue)
      }
    },
    forget() {
      state.forgotten = true
      for (const [key, queue] of queues) {
        clearTimeout(queue.retry)
        for (const job of [...queue.jobs, ...queue.retained]) job.resolve()
        status(key, queue, undefined)
      }
      queues.clear()
    },
    close() {
      if (closed) return Promise.all(inFlight)
      closed = owner.closed = true
      for (const [key, queue] of queues) {
        clearTimeout(queue.retry)
        queue.retry = undefined
        if (!queue.jobs[0]?.onWire) queue.busy = false
        const rest = queue.jobs.splice(queue.jobs[0]?.onWire ? 1 : 0)
        if (queue.jobs[0]?.onWire) queue.jobs[0].beforeRetained ??= rest[0]
        for (const job of rest) job.resolve()
        queue.retained.push(...rest)
        if (rest.length > 0) status(key, queue, { state: 'error', error: queue.status?.error || 'Stopped before delivery' })
      }
      return Promise.all(inFlight)
    },
  }
}
