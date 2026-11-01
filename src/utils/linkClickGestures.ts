import { isMacPlatform } from '@/utils/platform.js'

export interface BlockLinkClickModifierState {
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  button: number
}

export const linkClickActions = [
  {target: 'main', label: 'Open in main panel', modifiers: {shiftKey: false, altKey: true}},
  {target: 'sidebar-stack', label: 'Open in sidebar stack', modifiers: {shiftKey: true, altKey: false}},
  {target: 'new-panel', label: 'Open in new panel', modifiers: {shiftKey: true, altKey: true}},
] as const

export type BlockLinkClickIntent = typeof linkClickActions[number]['target'] | 'default' | 'native'

export const blockLinkClickIntent = (event: BlockLinkClickModifierState): BlockLinkClickIntent => {
  if (event.metaKey || event.ctrlKey || event.button !== 0) return 'native'
  return linkClickActions.find(({modifiers}) =>
    modifiers.shiftKey === event.shiftKey && modifiers.altKey === event.altKey,
  )?.target ?? 'default'
}

export const formatLinkClickGesture = (modifiers: {shiftKey: boolean; altKey: boolean}): string => {
  if (isMacPlatform()) {
    return `${modifiers.shiftKey ? '⇧' : ''}${modifiers.altKey ? '⌥' : ''} Click`.trim()
  }
  return [modifiers.shiftKey && 'Shift', modifiers.altKey && 'Alt', 'Click'].filter(Boolean).join('+')
}

export const nativeLinkClickGesture = (): string => isMacPlatform() ? '⌘ Click' : 'Ctrl+Click'
