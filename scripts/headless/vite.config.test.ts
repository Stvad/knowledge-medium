import {join} from 'node:path'
import {createServer} from 'vite'
import {ViteNodeServer} from 'vite-node/server'
import {expect, it} from 'vitest'

it('resolves extension syntax and the freezer from source through vite-node', async () => {
  const server = await createServer({
    configFile: join(import.meta.dirname, 'vite.config.ts'),
    server: {hmr: false, watch: null},
  })
  try {
    const loader = new ViteNodeServer(server)
    const importer = join(import.meta.dirname, 'extensionApprovals.ts')
    for (const module of ['extensionImportSyntax', 'freezeExtensionImports']) {
      const resolved = await loader.resolveId(`@knowledge-medium/agent-cli/${module}`, importer)
      expect(resolved?.id).toBe(join(import.meta.dirname, '../../packages/agent-cli/src', module + '.ts'))
    }
  } finally {
    await server.close()
  }
})
