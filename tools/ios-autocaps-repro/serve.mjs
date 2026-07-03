// Tiny static file server for the iOS autocaps repro — no deps, no build.
// Binds localhost (::1 + 127.0.0.1) so `tailscale serve --bg http://localhost:PORT`
// can tunnel it to a real device as a secure https://<machine>.ts.net context.
//
//   node serve.mjs            # port 5178
//   PORT=1234 node serve.mjs
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL(".", import.meta.url))
const PORT = Number(process.env.PORT) || 5178
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost")
    let path = decodeURIComponent(url.pathname)
    if (path === "/") path = "/index.html"
    const abs = normalize(join(ROOT, path))
    if (!abs.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return }
    const body = await readFile(abs)
    res.writeHead(200, {
      "content-type": TYPES[extname(abs)] || "application/octet-stream",
      "cache-control": "no-store",
    }).end(body)
  } catch {
    res.writeHead(404).end("not found")
  }
})
// Node listens on both stacks for the "localhost" name by default when host omitted.
server.listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`))
