import { readFileSync, writeFileSync } from 'node:fs'

// Preserve the service's runtime configuration when publishing both web and jobs.
// Secret values are never read or written; only Secret Manager references are copied.
export function runtimeConfig(service, origin, automationOverride, defaults = '', overrides = {}) {
  const environment = {}
  const secrets = Object.fromEntries(defaults.split(',').filter(Boolean).map(item => item.split('=')))
  const source = service?.spec?.template?.spec?.containers?.[0]?.env ?? []
  for (const entry of source) {
    if (entry.valueFrom) {
      const ref = entry.valueFrom.secretKeyRef
      if (!ref?.name || !ref.key) throw new Error('Unsupported secret reference: ' + entry.name)
      secrets[entry.name] = ref.name + ':' + ref.key
    } else if (entry.value !== undefined && !['PORT','K_SERVICE','K_REVISION','K_CONFIGURATION'].includes(entry.name)) {
      if (/^(MASTER_KEY|DATABASE_URL|.*SECRET)$/.test(entry.name)) {
        throw new Error('Move ' + entry.name + ' to Secret Manager before deploying.')
      }
      environment[entry.name] = String(entry.value)
    }
  }
  environment.PUBLIC_ORIGIN = new URL(origin).origin
  environment.AUTO_SEND_ENABLED = automationOverride ?? environment.AUTO_SEND_ENABLED ?? 'false'
  for (const name of ['AUTO_SEND_STORE','GOOGLE_SHARED_CALENDARS']) {
    if (overrides[name] !== undefined) environment[name] = overrides[name]
  }
  if (!['true','false'].includes(environment.AUTO_SEND_ENABLED)) throw new Error('AUTO_SEND_ENABLED must be true or false.')
  const shared = ['GOOGLE_SHARED_CALENDAR_STORE','GOOGLE_SHARED_CALENDAR_ID','GOOGLE_SHARED_CALENDAR_ACCOUNT']
  const configured = shared.filter(key => environment[key])
  if (configured.length && configured.length !== shared.length) throw new Error('Configure all three shared calendar settings together.')
  return { environment, bindings: Object.entries(secrets).map(([key,value]) => key + '=' + value).join(',') }
}

export function verifyTraffic(service, revision) {
  if (service.status?.latestReadyRevisionName !== revision) throw new Error('The ready revision changed during deployment.')
  const live = (service.status?.traffic ?? []).filter(item => item.percent > 0)
  if (live.length !== 1 || live[0].revisionName !== revision || live[0].percent !== 100) {
    throw new Error('The expected revision is not receiving 100% of traffic.')
  }
}

if (import.meta.main) {
  const [mode,input,...args] = process.argv.slice(2)
  const service = JSON.parse(readFileSync(input,'utf8'))
  if (mode === 'prepare') {
    const [output,origin,defaults] = args
    const config = runtimeConfig(service,origin,process.env.AUTO_SEND_ENABLED,defaults,process.env)
    writeFileSync(output + '/environment.json',JSON.stringify(config.environment),{mode:0o600})
    writeFileSync(output + '/bindings',config.bindings,{mode:0o600})
  } else if (mode === 'verify') {
    verifyTraffic(service,args[0])
  } else if (mode === 'staged-url') {
    if (service.status?.latestReadyRevisionName !== args[0]) throw new Error('The ready revision changed during deployment.')
    const tag = service.status?.traffic?.find(item => item.revisionName === args[0] && item.tag === args[1])
    if (!tag?.url?.startsWith('https://')) throw new Error('The staged revision has no HTTPS test URL.')
    process.stdout.write(tag.url)
  } else throw new Error('Unknown deployment check.')
}
