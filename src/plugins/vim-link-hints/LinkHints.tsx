import { useLayoutEffect, useMemo, useRef } from 'react'
import { matchKeybindingPress } from 'tinykeys'
import { BLOCK_SHELL_ATTRIBUTE } from '@/extensions/blockInteraction.js'
import { computeInstallableContexts } from '@/shortcuts/resolve.js'
import { ActionContextTypes, type BlockShortcutDependencies } from '@/shortcuts/types.js'
import { useActionDiscovery } from '@/shortcuts/useActionDiscovery.js'
import { isImeKeyEvent, withRecoveredLetterKey } from '@/shortcuts/utils.js'
import { isVisibleElement } from '@/utils/propertyNavigation.js'
import { boundPresses, hintLabels, hintLetters } from './model.ts'
import { alwaysShowLinkHintsFacet, linkHintsToggle } from './settings.ts'
import './linkHints.css'

const SHELL = `[${BLOCK_SHELL_ATTRIBUTE}]`
const HINT = 'data-vim-link-hint'

function isAvailableLink(link: HTMLAnchorElement, shell: HTMLElement): boolean {
  return link.hasAttribute('href')
    && link.closest(SHELL) === shell
    && !link.closest('[inert], [hidden], [aria-hidden="true"]')
    && isVisibleElement(link)
}

export function LinkHints() {
  const {runtime, active, contextConfigsByType, actions} = useActionDiscovery()
  const installable = useMemo(
    () => computeInstallableContexts(active, contextConfigsByType),
    [active, contextConfigsByType],
  )
  const normalMode = installable.has(ActionContextTypes.NORMAL_MODE)
    ? active.get(ActionContextTypes.NORMAL_MODE) as BlockShortcutDependencies
    : undefined
  const blockId = normalMode?.block.id
  const renderScopeId = normalMode?.renderScopeId
  const always = runtime.read(alwaysShowLinkHintsFacet).length > 0
  const presses = useMemo(() => boundPresses(actions, installable), [actions, installable])
  const letters = useMemo(() => hintLetters(presses), [presses])

  const toggleOwner = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => () => linkHintsToggle.close(), [])

  useLayoutEffect(() => {
    if (!blockId || !letters) {
      linkHintsToggle.close()
      return
    }
    const scope = renderScopeId === undefined
      ? ':not([data-render-scope-id])'
      : `[data-render-scope-id="${CSS.escape(renderScopeId)}"]`
    const selector = `${SHELL}[data-block-id="${CSS.escape(blockId)}"]${scope}`
    const selected = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(isVisibleElement)
    if (!selected) return
    let shell: HTMLElement | null = null
    let links = new Map<string, HTMLAnchorElement>()
    let prefix = ''

    const paint = () => {
      for (const [label, link] of links) {
        if (label.startsWith(prefix)) link.setAttribute(HINT, label.slice(prefix.length))
        else link.removeAttribute(HINT)
      }
    }
    const clear = () => {
      for (const link of links.values()) link.removeAttribute(HINT)
      links.clear()
      prefix = ''
    }
    const refresh = () => {
      observer.disconnect()
      const toggled = linkHintsToggle.isOpen()
      toggleOwner.current = toggled ? shell : null
      if (!shell || always === toggled) {
        clear()
        return
      }
      const root = shell
      const content = root.querySelector('.block-content')
      if (!content || content.closest(SHELL) !== root) {
        clear()
        observer.observe(root, {childList: true, subtree: true})
        return
      }
      const anchors = Array.from(content.querySelectorAll('a[href]'))
        .filter((link): link is HTMLAnchorElement => link instanceof HTMLAnchorElement && isAvailableLink(link, root))
      const labels = hintLabels(letters, anchors.length)
      if (labels.length !== links.size || labels.some((label, index) => links.get(label) !== anchors[index])) {
        clear()
        links = new Map(labels.map((label, index) => [label, anchors[index]!]))
        paint()
      }
      observer.observe(content, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['href', 'hidden', 'inert', 'aria-hidden', 'class', 'style'],
      })
      if (content.parentElement) observer.observe(content.parentElement, {childList: true})
    }

    const observer = new MutationObserver(refresh)
    const setShell = (next: HTMLElement | null) => {
      if (next === shell) return
      shell = next
      refresh()
    }

    // A click can focus a different shell before it claims normal mode.
    // Keep its trigger pending until that claim supplies the new selection.
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element && selected.contains(event.target)
        && event.target.closest(SHELL) === selected) {
        setShell(selected)
      } else {
        setShell(null)
        linkHintsToggle.close()
      }
    }
    const onFocusOut = (event: FocusEvent) => {
      if (!event.relatedTarget || event.relatedTarget === document.body) setShell(selected)
    }
    const onKeyDown = (rawEvent: KeyboardEvent) => {
      const target = rawEvent.target
      if (!shell || rawEvent.defaultPrevented || !links.size) return
      if (target instanceof Element && target !== document.body && !target.matches(SHELL)
        && (!shell.contains(target) || target.closest('input, textarea, select, button, [contenteditable="true"]'))) return
      if (isImeKeyEvent(rawEvent) || rawEvent.getModifierState('AltGraph')) return
      const event = withRecoveredLetterKey(rawEvent)
      if (event.getModifierState(event.key)) return
      if (event.key === 'Escape' && !always) {
        linkHintsToggle.close()
        return
      }

      const key = event.key.toLowerCase()
      const next = prefix + key
      const hasCandidate = key.length === 1 && letters.includes(key)
        && Array.from(links.keys()).some(label => label.startsWith(next))
      // A physical-code binding can map to a different letter on this layout.
      // Check the actual event before claiming any candidate.
      const matchesBinding = hasCandidate && presses.some(press => {
        const pattern = press[2]
        if (pattern instanceof RegExp) pattern.lastIndex = 0
        return matchKeybindingPress(event, press)
      })
      if (!hasCandidate || matchesBinding) {
        if (prefix) {
          prefix = ''
          paint()
        }
        return
      }

      const link = links.get(next)
      if (link && !isAvailableLink(link, shell)) return
      rawEvent.preventDefault()
      if (event.repeat) return
      if (!link) {
        prefix = next
        paint()
        return
      }

      if (always) {
        prefix = ''
        paint()
      } else {
        linkHintsToggle.close()
      }
      // Let the anchor and the browser apply the same navigation policy as a click.
      link.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      }))
    }

    const unsubscribe = linkHintsToggle.subscribe(refresh)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('keydown', onKeyDown)
    if (toggleOwner.current && toggleOwner.current !== selected) linkHintsToggle.close()
    toggleOwner.current = null
    const focused = document.activeElement
    if (!focused || focused === document.body || focused.matches(SHELL) || selected.contains(focused)) {
      setShell(selected)
    }
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('keydown', onKeyDown)
      observer.disconnect()
      unsubscribe()
      clear()
    }
  }, [always, blockId, letters, presses, renderScopeId])

  return null
}
