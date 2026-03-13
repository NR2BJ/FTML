const AUTH_COOKIE_NAME = 'ftml_token'

function buildCookieSuffix() {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  return `Path=/; SameSite=Lax${secure}`
}

export function getStoredAuthToken(): string {
  return localStorage.getItem('token') || ''
}

export function persistAuthToken(token: string) {
  localStorage.setItem('token', token)
  document.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; ${buildCookieSuffix()}`
}

export function clearStoredAuthToken() {
  localStorage.removeItem('token')
  document.cookie = `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`
}

export function syncAuthTokenCookie() {
  const token = getStoredAuthToken()
  if (token) {
    document.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; ${buildCookieSuffix()}`
    return
  }
  clearStoredAuthToken()
}
