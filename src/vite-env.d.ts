/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_POWERSYNC_URL?: string
  readonly VITE_AGENT_RUNTIME_URL?: string
  readonly VITE_AGENT_RUNTIME_BRIDGE_SECRET?: string
  readonly VITE_OPENAI_REALTIME_TOKEN_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
