export const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

export const withOptionalProxy = (url: string, proxyUrl: string): string => {
  const proxy = trimTrailingSlash(proxyUrl.trim())
  return proxy ? `${proxy}/${url}` : url
}
