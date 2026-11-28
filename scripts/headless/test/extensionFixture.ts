import {createHash} from 'node:crypto'

export const fixtureUrl = 'https://cdn.invalid/fixture.mjs'
export const fixtureModule = 'export default "reviewed"; export const suffix = "effect";'
export const fixtureIntegrity = 'sha256-' + createHash('sha256').update(fixtureModule).digest('base64')
export const fixtureSource = `
import React, * as react from 'react'
import server, {renderToReadableStream} from 'react-dom/server'
import serverBrowser from 'react-dom/server.browser'
import staticRenderer from 'react-dom/static'
import staticBrowser from 'react-dom/static.browser'
import {ChangeScope} from '@/data/api/changeScope.js'
import {appEffectsFacet} from '@/extensions/core.js'
import label, {suffix} from '${fixtureUrl}' with {integrity: '${fixtureIntegrity}'}
const lazy = await import('@/extensions/core.js')
if (React.useState !== react.useState || typeof React.act !== 'undefined') throw new Error('React instance')
if (lazy.appEffectsFacet !== appEffectsFacet) throw new Error('facet instance')
if (server !== serverBrowser || typeof renderToReadableStream !== 'function' || 'renderToPipeableStream' in server) throw new Error('React server facade')
if (staticRenderer !== staticBrowser || 'prerenderToNodeStream' in staticRenderer) throw new Error('React static facade')
if (!process.versions.node || window.localStorage !== localStorage) throw new Error('host globals')
if (typeof require !== 'undefined' || typeof module !== 'undefined') throw new Error('CommonJS globals')
if (!import.meta.url.endsWith('/fixture-reviewed.tsx')) throw new Error('module identifier')
const jsx = <b>{label}</b>
console.info('fixture reviewed module evaluated')
export default appEffectsFacet.of({
  id: label + '-' + suffix,
  start({repo, workspaceId}) {
    setInterval(() => {}, 60_000)
    void repo.tx(tx => tx.create({workspaceId, parentId: null, orderKey: 'a0', content: jsx.props.children + '-' + suffix}),
      {scope: ChangeScope.BlockDefault}).then(() => console.info('fixture reviewed effect committed'))
    return () => console.info('fixture reviewed effect stopped')
  },
})
`.trim()
