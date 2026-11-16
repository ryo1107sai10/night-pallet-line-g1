const consoleHome = 'https://developers.line.biz/console/'
const number = value => /^\d{5,20}$/.test(value?.trim()) ? value.trim() : ''
const appId = /^\d{5,20}-[A-Za-z0-9]+$/

export function liffAppId(value) {
  const input = value.trim()
  if (appId.test(input)) return input
  const match = /^https:\/\/liff\.line\.me\/([^/?#]+)\/?(?:[?#].*)?$/.exec(input)
  return match && appId.test(match[1]) ? match[1] : ''
}

export function lineSetupLinks({provider_id, messaging_id, login_id, liff_id} = {}) {
  const provider = number(provider_id)
  const messaging = number(messaging_id)
  const login = number(login_id)
  const liffApp = liffAppId(liff_id ?? '')
  const providerPage = provider ? consoleHome + 'provider/' + provider : consoleHome
  const messagingPage = messaging ? consoleHome + 'channel/' + messaging : ''
  const loginPage = login ? consoleHome + 'channel/' + login : ''
  const liffPage = loginPage ? loginPage + '/liff' : ''
  return {
    manager: 'https://manager.line.biz/',
    create: 'https://entry.line.biz/form/entry/unverified',
    provider: provider ? providerPage + '/settings' : consoleHome,
    messagingBasics: messagingPage || providerPage,
    messagingSettings: messagingPage ? messagingPage + '/messaging-api' : providerPage,
    loginBasics: loginPage || providerPage,
    liff: liffPage || providerPage,
    liffEdit: liffPage && liffApp.startsWith(login + '-') ? liffPage + '/' + liffApp : liffPage || providerPage,
  }
}
