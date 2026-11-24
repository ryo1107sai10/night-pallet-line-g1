import { setTimeout as delay } from 'node:timers/promises'
import { GoogleAuth, OAuth2Client } from 'google-auth-library'
import type pg from 'pg'
import { z } from 'zod'
import { automationForStore, type Config, type Route } from './core.js'
import { processChannelEvents } from './jobs.js'
import type { LineAPI } from './line.js'
import { deliverService } from './service-delivery.js'

export const lineDispatchPath = '/internal/line-dispatch'
export const lineDispatchInput = z.strictObject({
  channel: z.uuid(),
  source: z.enum(['webhook','service']),
})
type DispatchInput = z.infer<typeof lineDispatchInput>

export type LineDispatch = {
  wake: (input: DispatchInput) => Promise<void>
  verify: (authorization: string) => Promise<boolean>
}

export function lineDispatchFromEnvironment(cfg: Config): LineDispatch | undefined {
  const queue = process.env.LINE_DISPATCH_QUEUE
  const account = process.env.LINE_DISPATCH_ACCOUNT
  if (!cfg.external || !queue || !account) return
  if (!/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/queues\/[\w-]+$/.test(queue) ||
      !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(account)) {
    throw new Error('Invalid LINE dispatch queue or service account.')
  }
  const url = cfg.origin + lineDispatchPath
  const auth = new GoogleAuth({scopes: ['https://www.googleapis.com/auth/cloud-platform']})
  const oidc = new OAuth2Client()
  let client: ReturnType<GoogleAuth['getClient']> | undefined
  return {
    async wake(input) {
      const signal = AbortSignal.timeout(700)
      const request = async () => {
        client ??= auth.getClient().catch(error => { client = undefined; throw error })
        await (await client).request({
          url: 'https://cloudtasks.googleapis.com/v2/' + queue + '/tasks',
          method: 'POST',
          signal,
          retry: false,
          data: {task: {dispatchDeadline: '35s', httpRequest: {
            httpMethod: 'POST', url, headers: {'Content-Type': 'application/json'},
            body: Buffer.from(JSON.stringify(input)).toString('base64'),
            oidcToken: {serviceAccountEmail: account, audience: url},
          }}},
        })
      }
      // The signed LINE webhook must be acknowledged even if task creation is slow.
      // Both the event and the notification were already committed for the minute worker.
      await Promise.race([request(), delay(700, undefined, {ref: false}).then(() => {
        throw new Error('LINE dispatch enqueue timed out')
      })]).catch(() => console.warn('LINE dispatch enqueue failed; scheduled worker will recover'))
    },
    async verify(authorization) {
      const match = /^Bearer ([\w.-]+)$/.exec(authorization)
      if (!match || match[1].length > 4096) return false
      try {
        const ticket = await oidc.verifyIdToken({idToken: match[1], audience: url})
        const claims = ticket.getPayload()
        return claims?.email_verified === true && claims.email === account
      } catch {
        return false
      }
    },
  }
}

export async function dispatchLineWork(pool: pg.Pool, cfg: Config, line: LineAPI, input: DispatchInput) {
  const {rows: [r]} = await pool.query<Route>(
    'SELECT * FROM channel_route WHERE id=$1', [input.channel])
  if (!r || !automationForStore(cfg,r.store_id) ||
      r.module_channel_id && r.module_channel_id !== cfg.lineModule?.id) return
  if (input.source === 'webhook') await processChannelEvents(pool,cfg,r)
  const finishBefore = Date.now() + 18000
  for (let sent = 0; sent < 8 && Date.now() < finishBefore; sent++) {
    if (!await deliverService(pool,cfg,line,r,true)) break
  }
}
