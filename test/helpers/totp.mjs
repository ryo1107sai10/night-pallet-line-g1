import { setTimeout as delay } from 'node:timers/promises'
import { Secret, TOTP } from 'otpauth'

// Activation consumes the previous interval so login can use the current one.
// Generating it just before an interval boundary makes it two intervals old by
// the time the HTTP handler verifies it. Wait only in that case, in test code.
export async function previousCode(key,{now=Date.now,pause=delay}={}) {
  const period=30000
  let timestamp=now()
  if(timestamp%period>=15000){
    await pause(period-timestamp%period+50)
    timestamp=now()
  }
  return new TOTP({secret:Secret.fromBase32(key)}).generate({timestamp:timestamp-period})
}
