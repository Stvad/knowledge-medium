export const themes = ['light', 'dark'] as const

export type Theme = typeof themes[number]

const getDocumentRoot = (): HTMLElement => window.document.documentElement

export const getCurrentTheme = (root: HTMLElement = getDocumentRoot()): Theme =>
  root.classList.contains('dark') ? 'dark' : 'light'

export const applyTheme = (
  theme: Theme,
  root: HTMLElement = getDocumentRoot(),
): Theme => {
  root.classList.remove(...themes)
  root.classList.add(theme)
  return theme
}

export const toggleTheme = (root: HTMLElement = getDocumentRoot()): Theme => {
  const nextTheme = getCurrentTheme(root) === 'light' ? 'dark' : 'light'
  return applyTheme(nextTheme, root)
}
