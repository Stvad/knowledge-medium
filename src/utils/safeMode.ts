export const hasSafeModeSearchParam = (value: string | null): boolean =>
  value !== null

export const searchHasSafeModeFlag = (search: string): boolean =>
  new URLSearchParams(search).has('safeMode')

export const buildSafeModeUrl = (href: string): string => {
  const url = new URL(href)
  url.searchParams.set('safeMode', '')
  return url.toString()
}

export const reloadInSafeMode = (location: Location = window.location): void => {
  const next = buildSafeModeUrl(location.href)
  if (next === location.href) {
    location.reload()
    return
  }
  location.assign(next)
}
