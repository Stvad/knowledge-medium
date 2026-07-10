/**
 * Toast facade. Thin wrapper around `sonner` so call sites stay
 * stable if we swap libs later — and so project-wide defaults
 * (durations, position, theming) live in one place.
 *
 * Two shapes:
 *  - One-shot toasts (`showError`, `showInfo`, `showSuccess`) for
 *    discrete events (alias-collision rejection, "import done",
 *    "couldn't reach server").
 *  - Progress toasts (`showProgress`) for long-running ops with
 *    incremental updates. Returns a handle with `update / done /
 *    fail` matching the previous `progressBanner` API so existing
 *    callers (roam-import, SQLite export/import) need only swap
 *    the import.
 *
 * Calling these from non-React code is fine — sonner mounts via a
 * `<Toaster />` at the app root and exposes the `toast` function
 * from module scope. The `<Toaster />` is mounted in main.tsx.
 */
import type React from 'react'
import { toast as sonnerToast } from 'sonner'

/** The click event handed to a toast action's `onClick`. On the primary
 *  `action` button, call `preventDefault()` to KEEP the toast open after the
 *  action fires — sonner otherwise dismisses the toast on the click. NOTE:
 *  the `cancel` (secondary) button always dismisses; sonner ignores
 *  `preventDefault` there. Handlers that don't need this can ignore the arg. */
export interface ToastActionEvent {
  preventDefault: () => void
}

export interface ToastAction {
  label: string
  /** `event` is present when the toast lib invokes the handler on a real
   *  click (optional so call sites/tests can invoke without one). Call
   *  `event?.preventDefault()` to keep the toast open. */
  onClick: (event?: ToastActionEvent) => void
}

export interface ToastOptions {
  /** Override default duration (ms). Default depends on toast kind. */
  duration?: number
  /** Optional action button (label + click handler). Renders as a
   *  button inside the toast — used for "Open conflicting block",
   *  "Retry", etc. */
  action?: ToastAction
  /** Optional secondary button, rendered alongside `action` (sonner's
   *  `cancel` slot). Use for a "Dismiss"/"Not now" affordance next to a
   *  primary action — e.g. the extension prompt's Enable + Dismiss pair. */
  cancel?: ToastAction
  /** Stable id — passing the same id reuses the same toast slot
   *  (replaces existing content with the new message). Used by
   *  `showProgress` for in-place updates. */
  id?: string | number
}

// Pass `action` straight through (label + the handler, which receives the
// toast lib's click event verbatim so it can preventDefault). Absent → no
// button.
const buildAction = (action: ToastAction | undefined) =>
  action ? {label: action.label, onClick: action.onClick} : undefined

export const showError = (message: string, opts: ToastOptions = {}): string | number =>
  sonnerToast.error(message, {
    duration: opts.duration ?? 6000,
    action: buildAction(opts.action),
    cancel: buildAction(opts.cancel),
    id: opts.id,
  })

export const showInfo = (message: string, opts: ToastOptions = {}): string | number =>
  sonnerToast(message, {
    duration: opts.duration ?? 4000,
    action: buildAction(opts.action),
    cancel: buildAction(opts.cancel),
    id: opts.id,
  })

export const showSuccess = (message: string, opts: ToastOptions = {}): string | number =>
  sonnerToast.success(message, {
    duration: opts.duration ?? 4000,
    action: buildAction(opts.action),
    cancel: buildAction(opts.cancel),
    id: opts.id,
  })

/** Render a fully custom toast (JSX). Use when the toast needs internal
 *  reactive state — e.g. a button whose enabled-state depends on a live
 *  subscription — that the standard `action` shape can't express. The
 *  render fn receives the sonner toast id so the JSX can dismiss itself
 *  on user action. */
export const showCustom = (
  render: (id: string | number) => React.ReactElement,
  opts: Pick<ToastOptions, 'duration' | 'id'> = {},
): string | number =>
  sonnerToast.custom(render, {
    duration: opts.duration ?? 4000,
    ...(opts.id !== undefined ? {id: opts.id} : {}),
  })

export interface ProgressToast {
  /** Replace the message in place. The toast stays open. */
  update: (message: string) => void
  /** Resolve the toast successfully. Pass a final message to show
   *  briefly before dismissing; omit to dismiss immediately. */
  done: (finalMessage?: string) => void
  /** Resolve the toast as an error and display the failure
   *  message. Stays visible longer than info/success so the user
   *  can read what went wrong. */
  fail: (message: string) => void
}

/** Start a progress toast. Returns a handle for incremental updates
 *  and terminal resolution. Implemented on top of sonner's id-reuse
 *  pattern: subsequent `toast.success` / `toast.error` calls with
 *  the same id replace the loading toast in place. */
export const showProgress = (initial: string): ProgressToast => {
  const id = sonnerToast.loading(initial, {duration: Number.POSITIVE_INFINITY})
  return {
    update: (message: string) => {
      sonnerToast.loading(message, {id, duration: Number.POSITIVE_INFINITY})
    },
    done: (finalMessage?: string) => {
      if (finalMessage === undefined) {
        sonnerToast.dismiss(id)
        return
      }
      sonnerToast.success(finalMessage, {id, duration: 2500})
    },
    fail: (message: string) => {
      sonnerToast.error(message, {id, duration: 6000})
    },
  }
}

/** Dismiss a specific toast by id, or all toasts when `id` is
 *  omitted. */
export const dismissToast = (id?: string | number): void => {
  if (id === undefined) sonnerToast.dismiss()
  else sonnerToast.dismiss(id)
}
