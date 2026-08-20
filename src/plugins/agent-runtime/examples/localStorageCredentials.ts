const TOKEN_KEY = 'knowledge-medium:readwise:token:v1'

export const loadToken = () => window.localStorage.getItem(TOKEN_KEY) || null
export const saveToken = (t: string) => window.localStorage.setItem(TOKEN_KEY, t)
export const clearToken = () => window.localStorage.removeItem(TOKEN_KEY)

// Validate before saving so a typo doesn't get silently stored:
export const saveTokenIfValid = async (candidate: string): Promise<boolean> => {
  const ok = await fetch('https://readwise.io/api/v2/auth/', {
    headers: { Authorization: `Token ${candidate}` },
  }).then(r => r.status === 204)
  if (ok) saveToken(candidate)
  return ok
}
