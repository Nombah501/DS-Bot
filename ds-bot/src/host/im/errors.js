// Adapter errors retain wire status and retryAfter (seconds), plus the policy
// flags used by connection loops. kind names their delivery classification.
export function platformError(message, fields = {}, options = undefined) {
  const error = Object.assign(new Error(message, options), fields)
  error.kind = classify(error).kind
  return error
}

// Topic recovery precedes delivery policy. Once recovery is exhausted or disabled,
// the same error must still follow its original permanent/drop/retry policy.
export function classify(error, { topicRecovery = true } = {}) {
  let kind = 'retry'
  if (topicRecovery && error?.topicMissing === true) kind = 'topicMissing'
  else if (error?.permanent === true || (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 429)) kind = 'permanent'
  else if (error?.unknown === true || error?.stopped === true) kind = 'drop'
  return { kind, ...(error?.retryAfter !== undefined ? { retryAfterMs: Number(error.retryAfter) * 1000 } : {}) }
}

// Callers own capability, single-retry and post-recovery validity guards.
export async function recoverMissingTopic(error, chat, recover) {
  return classify(error).kind === 'topicMissing' && await recover(chat)
}
