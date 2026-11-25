const consoleHome = 'https://developers.line.biz/console/'
const managerHome = 'https://manager.line.biz/'
const plain = value => typeof value==='string'||typeof value==='number' ? String(value).normalize('NFKC').trim() : ''
const numeric = value => /^\d{5,20}$/.test(value) ? value : ''

function officialPath(value,origin) {
  try {
    const url=new URL(value)
    // Never use the pasted URL itself as a link. Only extract non-secret IDs
    // from an exact official HTTPS origin and rebuild a known destination.
    return url.origin===origin&&!url.username&&!url.password?url.pathname:''
  } catch {return ''}
}

export function lineConsoleId(value,type) {
  if(!['provider','channel'].includes(type))return ''
  const input=plain(value)
  if(numeric(input))return input
  const path=officialPath(input,'https://developers.line.biz')
  const match=new RegExp('^/console/'+type+'/(\\d{5,20})(?:/[a-zA-Z0-9_-]+)?/?$').exec(path)
  return match?.[1]??''
}

export function lineBasicId(value) {
  const input=plain(value)
  if(/^@?[a-zA-Z0-9._-]{1,30}$/.test(input))return input.startsWith('@')?input:'@'+input
  const path=officialPath(input,'https://manager.line.biz')
  const match=/^\/account\/(?:@|%40)([a-zA-Z0-9._-]{1,30})(?:\/[a-zA-Z0-9_-]+)*\/?$/i.exec(path)
  return match?'@'+match[1]:''
}

export function lineSetupLinks({provider_id, messaging_id, basic_id} = {}) {
  const provider = lineConsoleId(provider_id,'provider')
  const messaging = lineConsoleId(messaging_id,'channel')
  const basic = lineBasicId(basic_id)
  const providerPage = provider ? consoleHome + 'provider/' + provider : consoleHome
  const messagingPage = messaging ? consoleHome + 'channel/' + messaging : ''
  return {
    manager: managerHome,
    managerMessaging: basic ? managerHome+'account/'+basic+'/setting/messaging-api' : managerHome,
    console: consoleHome,
    create: 'https://entry.line.biz/form/entry/unverified',
    provider: provider ? providerPage + '/settings' : consoleHome,
    messagingBasics: messagingPage || providerPage,
    messagingSettings: messagingPage ? messagingPage + '/messaging-api' : providerPage,
    enableHelp:'https://www.lycbiz.com/jp/manual/OfficialAccountManager/account-settings_messaging_api/',
    permissionsHelp:'https://www.lycbiz.com/jp/manual/OfficialAccountManager/account-settings_permission/',
    responseHelp:'https://www.lycbiz.com/jp/manual/OfficialAccountManager/account-settings_response/',
    secretHelp:'https://developers.line.biz/ja/docs/messaging-api/verify-webhook-signature/',
    tokenHelp:'https://developers.line.biz/ja/docs/basics/channel-access-token/',
    webhookHelp:'https://developers.line.biz/ja/docs/messaging-api/building-bot/',
    hasProvider:!!provider,hasMessaging:!!messaging,hasBasic:!!basic,
  }
}
