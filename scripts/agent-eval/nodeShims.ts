/**
 * Browser globals the agent-runtime command module needs under vitest's NODE
 * environment. Node rather than happy-dom because the web environments run
 * Vite's `new URL(<literal>, import.meta.url)` asset rewrite, which turns the
 * km MCP server's package.json lookup into an http URL. Import this module
 * FIRST: the command module's graph reads `localStorage` at load time.
 * `window` / `document` are deliberately left undefined here — libraries
 * probe `typeof document` at load and take a DOM path when it exists — and
 * are provided by `provideRuntimeGlobals` once loading is done.
 */
class MemoryStorage {
  private readonly items = new Map<string, string>()
  get length() { return this.items.size }
  clear() { this.items.clear() }
  getItem(key: string) { return this.items.get(key) ?? null }
  key(index: number) { return [...this.items.keys()][index] ?? null }
  removeItem(key: string) { this.items.delete(key) }
  setItem(key: string, value: string) { this.items.set(key, String(value)) }
}

const globals = globalThis as Record<string, unknown>
globals.localStorage ??= new MemoryStorage()

/** The runtime context hands `window` / `document` to eval code; nothing
 *  the MCP tools call reads them, so they only need to exist. */
export const provideRuntimeGlobals = () => {
  globals.window ??= globalThis
  globals.document ??= {}
}
