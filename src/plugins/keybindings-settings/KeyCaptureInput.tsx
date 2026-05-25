/**
 * Single-chord capture input. Mounts as a small interactive surface
 * that listens for keydown, builds a hotkeys-js chord string via
 * `chordFromEvent`, and surfaces it back to the parent via
 * `onCapture`. The user confirms with the next non-modifier keypress
 * (chord commits immediately) and cancels with Escape.
 *
 * Stops propagation on every key event while focused so the captured
 * chord doesn't accidentally fire the action it's about to be bound
 * to.
 */
import {useCallback, useEffect, useRef} from 'react'
import {Button} from '@/components/ui/button.js'
import {Kbd} from '@/components/ui/kbd.js'
import {chordFromEvent, formatChord, isModifierOnly} from './keyCapture.ts'

export interface KeyCaptureInputProps {
  /** Chord string currently displayed while the user holds a partial
   *  combination. Render glyphs from this via `formatChord`. */
  pending: string | null
  /** Fires when a non-modifier key resolves the chord. The parent
   *  decides whether to commit immediately or stage for review. */
  onCapture: (chord: string) => void
  /** Fires while the user is still pressing modifiers — caller may
   *  use it to show "⌘…" hint feedback. */
  onPartial: (chord: string | null) => void
  onCancel: () => void
}

export const KeyCaptureInput = ({pending, onCapture, onPartial, onCancel}: KeyCaptureInputProps) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      onCancel()
      return
    }

    const native = event.nativeEvent
    if (isModifierOnly(native)) {
      // Partial: show ⌘… style preview while modifiers are pressed.
      const previewParts: string[] = []
      if (native.metaKey) previewParts.push('cmd')
      if (native.ctrlKey) previewParts.push('ctrl')
      if (native.altKey) previewParts.push('alt')
      if (native.shiftKey) previewParts.push('shift')
      onPartial(previewParts.length ? previewParts.join('+') : null)
      return
    }

    const chord = chordFromEvent({
      key: native.key,
      code: native.code,
      metaKey: native.metaKey,
      ctrlKey: native.ctrlKey,
      altKey: native.altKey,
      shiftKey: native.shiftKey,
    })
    if (chord) onCapture(chord)
  }, [onCancel, onCapture, onPartial])

  const handleKeyUp = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    // Modifiers released without a key resolving — clear the preview.
    if (isModifierOnly(event.nativeEvent)) onPartial(null)
  }, [onPartial])

  return (
    <div className="flex items-center gap-1">
      <div
        ref={ref}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={onCancel}
        className="inline-flex min-h-[28px] min-w-[120px] items-center justify-center rounded border border-dashed border-primary/60 bg-primary/5 px-2 py-1 text-xs outline-none focus:border-primary"
        aria-label="Press a key combination"
      >
        {pending ? <Kbd>{formatChord(pending)}…</Kbd> : <span className="text-muted-foreground">Press a key…</span>}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} title="Cancel">
        Cancel
      </Button>
    </div>
  )
}
