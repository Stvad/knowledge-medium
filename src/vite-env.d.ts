/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_POWERSYNC_URL?: string
  readonly VITE_AGENT_RUNTIME_URL?: string
  readonly VITE_AGENT_RUNTIME_BRIDGE_SECRET?: string
  /** Save Page Now credentials for the web-archive plugin (optional — it
   *  falls back to the unauthenticated save endpoint). Issued at
   *  archive.org/account/s3.php; set out of band, never committed. */
  readonly VITE_WEB_ARCHIVE_SPN_ACCESS_KEY?: string
  readonly VITE_WEB_ARCHIVE_SPN_SECRET_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Injected by Vite's `define` (vite.config.ts → resolveAppVersion). Read
// through src/appVersion.ts, which guards the not-defined case.
declare const __APP_VERSION__: import('./appVersion.ts').AppVersion
