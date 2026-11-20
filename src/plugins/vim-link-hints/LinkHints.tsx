import { useLayoutEffect, useMemo } from 'react'
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

  useLayoutEffect(() => () => linkHintsToggle.close(), [])

  useLayoutEffect(() => {
    if (!blockId || !letters) {
      linkHintsToggle.close()
      return
    }
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
      clear()
      if (!shell || always === linkHintsToggle.isOpen()) return
      const root = shell
      const content = root.querySelector('.block-content')
      if (!content || content.closest(SHELL) !== root) return
      const anchors = Array.from(content.querySelectorAll('a[href]'))
        .filter((link): link is HTMLAnchorElement => link instanceof HTMLAnchorElement && isAvailableLink(link, root))
      links = new Map(hintLabels(letters, anchors.length).map((label, index) => [label, anchors[index]!]))
      paint()
      observer.observe(content, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['href', 'hidden', 'inert', 'aria-hidden', 'class', 'style'],
      })
      if (content.parentElement) observer.observe(content.parentElement, {childList: true})
    }

    const observer = new MutationObserver(refresh)
    const setFocus = (target: EventTarget | null) => {
      const next = target instanceof HTMLElement
        && target.hasAttribute(BLOCK_SHELL_ATTRIBUTE)
        && target.dataset.blockId === blockId
        && target.dataset.renderScopeId === renderScopeId
        && target.dataset.editing !== 'true'
        ? target
        : null
      if (next === shell) return
      shell = next
      refresh()
    }

    const onFocusIn = (event: FocusEvent) => setFocus(event.target)
    // DOM focus can arrive before the new block claims normal mode. Reset
    // visibility on blur so a trigger pressed during that handoff survives.
    const onFocusOut = () => {
      setFocus(null)
      linkHintsToggle.close()
    }
    const onKeyDown = (rawEvent: KeyboardEvent) => {
      if (!shell || rawEvent.target !== shell || rawEvent.defaultPrevented || links.size === 0) return
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
    setFocus(document.activeElement)
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
