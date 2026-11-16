const prefixPattern = /^\/platform\/tenants\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const selection = /^(\/platform\/tenants\/[^/]+)\//i.exec(location.pathname)?.[1] ?? ''
export const workspace = prefixPattern.test(selection) ? selection : ''
export const workspacePath = path => workspace+path

export function scopeWorkspaceLinks() {
  if (!workspace) return
  for (const link of document.querySelectorAll('a[href^="/"]')) {
    const path = link.getAttribute('href')
    if (/^\/(?:master\/|staff\/|studio\/|operations\/|workflows\/|interview\/staff\.html)/.test(path)) {
      link.href = workspacePath(path)
    }
  }
}

export function rememberReturnWorkspace(kind,store) {
  if (workspace) sessionStorage.setItem('night-return-'+kind,store+':'+workspace)
  else sessionStorage.removeItem('night-return-'+kind)
}

export function returnWorkspace(kind,store) {
  const [selected,prefix] = (sessionStorage.getItem('night-return-'+kind) ?? '').split(':')
  return selected===store && prefixPattern.test(prefix ?? '') ? prefix : ''
}

export function forgetReturnWorkspace(kind) {
  sessionStorage.removeItem('night-return-'+kind)
}
