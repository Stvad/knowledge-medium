import { useLayoutEffect, useMemo, useRef, useState } from 'react'
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
const DEPTH = '--vim-link-hint-depth'

function acceptsHintKeys(target: EventTarget | null): boolean {
  return target === document.body || (
    target instanceof HTMLElement && !target.isContentEditable
    && (target.matches(SHELL) || (target.matches('a[href]') && !!target.closest(SHELL)))
  )
}

function isAvailableLink(link: HTMLAnchorElement, shell: HTMLElement): boolean {
  return link.hasAttribute('href')
    && link.closest(SHELL) === shell
    && !link.closest('[inert], [hidden], [aria-hidden="true"]')
    && isVisibleElement(link)
}

export function LinkHints() {
  const touchCapable = navigator.maxTouchPoints > 0
  const [usingKeyboard, setUsingKeyboard] = useState(false)
  const hintsAvailable = !touchCapable || usingKeyboard
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
    if (!touchCapable) return
    // On touchscreens, use keyboard input outside editors as evidence
    // that hint keys are usable. A subsequent touch or pen press hides them.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isTrusted && !isImeKeyEvent(event) && acceptsHintKeys(event.target)) setUsingKeyboard(true)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.pointerType === 'pen') setUsingKeyboard(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [touchCapable])

  useLayoutEffect(() => {
    if (!hintsAvailable || !blockId || !letters) {
      toggleOwner.current = null
      linkHintsToggle.close()
      return
    }
    const scope = renderScopeId === undefined
      ? ':not([data-render-scope-id])'
      : `[data-render-scope-id="${CSS.escape(renderScopeId)}"]`
    const selector = `${SHELL}[data-block-id="${CSS.escape(blockId)}"]${scope}`
    const selected = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(isVisibleElement)
    if (!selected) return
    let acceptsInput = false
    let links = new Map<string, HTMLAnchorElement>()
    let prefix = ''

    const paint = () => {
      for (const [label, link] of links) {
        if (label.startsWith(prefix)) link.setAttribute(HINT, label.slice(prefix.length))
        else link.removeAttribute(HINT)
      }
    }
    const clear = () => {
      for (const link of links.values()) {
        link.removeAttribute(HINT)
        link.style.removeProperty(DEPTH)
      }
      links.clear()
      prefix = ''
    }
    const refresh = () => {
      observer.disconnect()
      const toggled = linkHintsToggle.isOpen()
      toggleOwner.current = toggled && acceptsInput ? selected : null
      if (!acceptsInput || always === toggled) {
        clear()
        return
      }
      const content = selected.querySelector('.block-content')
      if (!content || content.closest(SHELL) !== selected) {
        clear()
        observer.observe(selected, {childList: true, subtree: true})
        return
      }
      const anchors = Array.from(content.querySelectorAll('a[href]'))
        .filter((link): link is HTMLAnchorElement => link instanceof HTMLAnchorElement && isAvailableLink(link, selected))
      const labels = hintLabels(letters, anchors.length)
      if (labels.length !== links.size || labels.some((label, index) => links.get(label) !== anchors[index])) {
        clear()
        links = new Map(labels.map((label, index) => [label, anchors[index]!]))
        // Equal-width badges start one badge-width apart when nested links
        // share their first glyph. DOM order visits each outer link first.
        const depths = new Map<HTMLAnchorElement, number>()
        for (const link of links.values()) {
          const parent = link.parentElement?.closest<HTMLAnchorElement>('a[href]')
          const depth = parent && depths.has(parent) ? depths.get(parent)! + 1 : 0
          depths.set(link, depth)
          if (depth) link.style.setProperty(DEPTH, String(depth))
        }
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
    const setAcceptsInput = (next: boolean) => {
      if (next === acceptsInput) return
      acceptsInput = next
      refresh()
    }

    // A click can focus a different shell before it claims normal mode.
    // Keep its trigger pending until that claim supplies the new selection.
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element && acceptsHintKeys(event.target)
        && event.target.closest(SHELL) === selected) {
        setAcceptsInput(true)
      } else {
        setAcceptsInput(false)
        linkHintsToggle.close()
      }
    }
    const onFocusOut = (event: FocusEvent) => {
      if (!event.relatedTarget || event.relatedTarget === document.body) setAcceptsInput(true)
    }
    const onKeyDown = (rawEvent: KeyboardEvent) => {
      if (!acceptsInput || !acceptsHintKeys(rawEvent.target) || rawEvent.defaultPrevented || !links.size) return
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
      // Modified shortcuts and physical-key bindings on this layout take priority.
      const matchesBinding = hasCandidate && presses.some(({press}) => {
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
      if (link && !isAvailableLink(link, selected)) return
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
    setAcceptsInput(acceptsHintKeys(document.activeElement))
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('keydown', onKeyDown)
      observer.disconnect()
      unsubscribe()
      clear()
    }
  }, [always, blockId, hintsAvailable, letters, presses, renderScopeId])

  return null
}
