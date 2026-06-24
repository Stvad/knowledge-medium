/*
  The "wolf" theme + the pop-stack that applies and restores it.

  Design notes:
  - Wolf is applied through the SAME data-theme mechanism as every other
    theme (so the user keeps full control: the normal theme switcher just
    works, and whatever he picks wins). But it is deliberately NOT
    contributed via `themesFacet`, so it never joins the toggle cycle or
    the command-palette theme list. Because it's unregistered,
    `applyTheme('wolf')` (which resolves ids through the registry) wouldn't
    find it — so we set `data-theme` / persist directly via `setThemeId`,
    and inject the palette ourselves under `[data-theme="wolf"]`.
  - Pop stack, not an override layer: on the birthday we save the user's
    current theme and switch to wolf; after the birthday we restore it —
    but ONLY if he never touched it (live theme is still wolf). If he
    picked another theme during the day, that's his deliberate choice and
    we leave it. That "restore only if untouched" guard is what makes the
    normal theme switcher double as the escape hatch.
*/

import { THEME_STORAGE_KEY } from '@/plugins/theme-toggle/theme.js'

export const WOLF_THEME_ID = 'wolf'

const PREV_KEY = 'birthday:wolf:prev'
const ACTIVE_KEY = 'birthday:wolf:active'
const STYLE_EL_ID = 'birthday-wolf-theme'

/** Restore target of last resort, if storage was cleared mid-celebration
 *  and we have no saved previous theme. Matches the app's runtime default. */
const DEFAULT_RESTORE = 'sunset-warm-light'

/** Complete midnight-wolf palette. A partial token set inherits the
 *  `:root` (light) default for any missing key and produces a half-lit
 *  palette, so every token a default theme sets is set here too. */
const wolfTokens: Readonly<Record<string, string>> = {
  background: '224 47% 8%',
  foreground: '210 30% 88%',
  card: '224 44% 11%',
  'card-foreground': '210 30% 88%',
  popover: '224 44% 11%',
  'popover-foreground': '210 30% 88%',
  primary: '205 90% 72%',
  'primary-foreground': '224 47% 9%',
  secondary: '221 30% 18%',
  'secondary-foreground': '210 30% 90%',
  muted: '221 26% 16%',
  'muted-foreground': '214 22% 68%',
  accent: '250 38% 30%',
  'accent-foreground': '220 40% 92%',
  destructive: '0 62% 47%',
  'destructive-foreground': '0 0% 98%',
  border: '212 26% 30%',
  input: '214 25% 24%',
  ring: '205 90% 72%',
  link: '205 90% 76%',
  wikilink: '258 70% 80%',
  code: '221 26% 16%',
  success: '142 50% 52%',
  radius: '0.65rem',
  'chart-1': '205 90% 72%',
  'chart-2': '250 60% 70%',
  'chart-3': '190 70% 60%',
  'chart-4': '280 55% 68%',
  'chart-5': '160 50% 55%',
}

/* The wolf bullet. The dot's own fill is dropped and a tiny wolf is drawn
   on a centered ::before, so the surrounding <a class="bullet-link"> keeps
   its click/zoom/context-menu behavior untouched. A collapsed block with
   children carries `.bullet-with-children` (+ a `border-4` ring): we hide
   that hard ring and replace it with a soft moon-glow disc behind a
   slightly smaller wolf, so it reads as a wolf sitting in the moon rather
   than a wolf jammed inside a ring. */
const WOLF_BULLET_CSS = `
[data-theme="${WOLF_THEME_ID}"] .bullet {
  background-color: transparent;
  position: relative;
  overflow: visible;
}
[data-theme="${WOLF_THEME_ID}"] .bullet::before {
  content: "🐺";
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 13px;
  line-height: 1;
  pointer-events: none;
  filter: saturate(0.85);
}
[data-theme="${WOLF_THEME_ID}"] .bullet-with-children {
  border-color: transparent;
  box-shadow:
    0 0 0 1.5px hsl(var(--ring) / 0.35),
    0 0 8px 2px hsl(var(--ring) / 0.40);
}
[data-theme="${WOLF_THEME_ID}"] .bullet-with-children::before {
  font-size: 12px;
}
[data-theme="${WOLF_THEME_ID}"] .bullet-link:hover .bullet::before {
  transform: translate(-50%, -50%) scale(1.15);
}
`

function buildWolfStylesheet(): string {
  const tokenLines = Object.entries(wolfTokens)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join('\n')
  return `[data-theme="${WOLF_THEME_ID}"] {\n${tokenLines}\n}\n${WOLF_BULLET_CSS}`
}

function ensureWolfStylesheet(): void {
  if (document.getElementById(STYLE_EL_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_EL_ID
  el.textContent = buildWolfStylesheet()
  document.head.appendChild(el)
}

function removeWolfStylesheet(): void {
  document.getElementById(STYLE_EL_ID)?.remove()
}

function liveThemeId(): string {
  return document.documentElement.dataset.theme ?? ''
}

/** Set `data-theme` and persist it, bypassing the theme registry (wolf is
 *  intentionally unregistered; restore ids are real themes whose palette
 *  CSS exists regardless of registry-population order at startup). */
function setThemeId(id: string): void {
  document.documentElement.dataset.theme = id
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, id)
  } catch {
    // best-effort; the visual switch still took effect
  }
}

/** Re-apply the wolf theme on demand (the command-palette entry). Just
 *  flips the live theme — it doesn't touch the pop-stack markers, so the
 *  saved "restore to" theme is preserved. Safe to call any number of
 *  times; the stylesheet injection is idempotent. */
export function applyWolfTheme(): void {
  ensureWolfStylesheet()
  setThemeId(WOLF_THEME_ID)
}

function read(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function remove(key: string): void {
  try {
    window.localStorage?.removeItem(key)
  } catch {
    /* ignore */
  }
}

/**
 * The whole pop-stack, idempotent and safe to call on every load (and at
 * each local-midnight tick). For any non-recipient on any normal day this
 * is a no-op: there's no active marker and `isBirthday` is false.
 *
 * @param isBirthday  recipient AND the local date is the birthday
 * @param cycle       dedup key for this celebration (year, or 'force')
 */
export function syncWolfTheme(isBirthday: boolean, cycle: string): void {
  const marker = read(ACTIVE_KEY)

  if (isBirthday) {
    ensureWolfStylesheet()
    if (marker !== cycle) {
      // First activation this cycle: remember the real theme to restore.
      // Never record 'wolf' itself as the restore target — if we're
      // somehow already on wolf (double activation), keep the existing
      // saved value instead.
      const live = liveThemeId()
      const prev =
        live === WOLF_THEME_ID ? read(PREV_KEY) ?? DEFAULT_RESTORE : live
      write(PREV_KEY, prev)
      write(ACTIVE_KEY, cycle)
      setThemeId(WOLF_THEME_ID)
    }
    // Already active: respect whatever theme is live — the user may have
    // switched away himself, and we never re-force wolf.
    return
  }

  if (marker) {
    // Celebration window has passed. Restore only if untouched; if the
    // user picked another theme during the day, that IS his choice.
    if (liveThemeId() === WOLF_THEME_ID) {
      setThemeId(read(PREV_KEY) ?? DEFAULT_RESTORE)
    }
    remove(ACTIVE_KEY)
    remove(PREV_KEY)
    removeWolfStylesheet()
  }
}
