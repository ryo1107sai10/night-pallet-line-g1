const consoleHome = 'https://developers.line.biz/console/'
const number = value => /^\d{5,20}$/.test(value?.trim()) ? value.trim() : ''

export function lineSetupLinks({provider_id, messaging_id} = {}) {
  const provider = number(provider_id)
  const messaging = number(messaging_id)
  const providerPage = provider ? consoleHome + 'provider/' + provider : consoleHome
  const messagingPage = messaging ? consoleHome + 'channel/' + messaging : ''
  return {
    manager: 'https://manager.line.biz/',
    create: 'https://entry.line.biz/form/entry/unverified',
    provider: provider ? providerPage + '/settings' : consoleHome,
    messagingBasics: messagingPage || providerPage,
    messagingSettings: messagingPage ? messagingPage + '/messaging-api' : providerPage,
  }
}
