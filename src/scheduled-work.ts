import { OAuth2Client } from 'google-auth-library'
import type { Config } from './core.js'

export const scheduledWorkPath = '/internal/scheduled-work'

export type ScheduledWork = {
  verify: (authorization: string) => Promise<boolean>
  run: () => Promise<void>
}

// A scheduler retry or overlapping invocation must not start a second sweep
// in the same instance. Individual delivery claims retain their database locks
// and LINE retry keys, including across instance restarts.
export function coalesceScheduledWork(work: () => Promise<void>) {
  let pending: Promise<void> | undefined
  return () => {
    if (!pending) pending = Promise.resolve().then(work).finally(() => { pending = undefined })
    return pending
  }
}

export function scheduledWorkFromEnvironment(cfg: Config, work: () => Promise<void>): ScheduledWork | undefined {
  const account = process.env.SCHEDULE_WORKER_ACCOUNT
  if (!cfg.external || !account) return
  if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(account)) {
    throw new Error('Invalid scheduled worker service account.')
  }
  const audience = cfg.origin + scheduledWorkPath
  const oidc = new OAuth2Client()
  return {
    async verify(authorization) {
      const match = /^Bearer ([\w.-]+)$/.exec(authorization)
      if (!match || match[1].length > 4096) return false
      try {
        const ticket = await oidc.verifyIdToken({idToken:match[1],audience})
        const claims = ticket.getPayload()
        return claims?.email_verified === true && claims.email === account
      } catch { return false }
    },
    run:coalesceScheduledWork(work),
  }
}
