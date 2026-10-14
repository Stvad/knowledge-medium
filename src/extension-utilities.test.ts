import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import postcss, { type Root } from 'postcss'
import tailwindcss from '@tailwindcss/postcss'
import { describe, expect, it } from 'vitest'

const appStylesheet = fileURLToPath(new URL('./index.css', import.meta.url))
const safelistStylesheet = fileURLToPath(new URL('./extension-utilities.css', import.meta.url))

// Same plugin and default options as postcss.config.js, so the content scan
// matches the build's.
const compile = async (file: string): Promise<Root> =>
  (await postcss([tailwindcss()]).process(await readFile(file, 'utf8'), {from: file})).root

/** Selectors Tailwind generated into `@layer utilities`. Rules index.css
 *  authors by hand are left out: `@reference` never re-emits them, so they
 *  must outrank a single class on their own (as `.bullet.page-bullet` does). */
const generatedUtilitySelectors = (root: Root): Set<string> => {
  const selectors = new Set<string>()
  root.walkAtRules('layer', layer => {
    if (layer.params !== 'utilities') return
    layer.each(node => {
      if (node.type === 'rule' && node.source?.input.file !== appStylesheet) selectors.add(node.selector)
    })
  })
  return selectors
}

describe('extension-utilities.css', () => {
  // The safelist lands after index.css in the same `utilities` layer, so it
  // wins every specificity tie. An app utility it does not re-emit loses to a
  // base utility it does: the video-notes split's `@md:flex-row` lost to
  // `flex-col` and stacked the notes under the video.
  it('re-emits every utility index.css generates, so its own ordering decides every tie', async () => {
    const app = generatedUtilitySelectors(await compile(appStylesheet))
    const safelist = generatedUtilitySelectors(await compile(safelistStylesheet))

    expect([...app].filter(selector => !safelist.has(selector))).toEqual([])
  }, 20_000) // ~0.5s alone; two full Tailwind compiles and a content scan.
})
