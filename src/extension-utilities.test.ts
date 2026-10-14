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

interface UtilityRule {
  selector: string
  css: string
}

/** `var(--x, fallback)` → `var(--x)`. Under `@reference` Tailwind writes each
 *  theme token's value in as a fallback; index.css defines every token its own
 *  utilities read, so the fallback never applies and the rules match without
 *  it. */
const withoutVarFallbacks = (css: string): string => {
  const fallbackStart = /var\((--[\w-]+),/g
  let out = ''
  let copiedUpTo = 0
  for (let match; (match = fallbackStart.exec(css));) {
    let end = fallbackStart.lastIndex
    for (let depth = 1; depth > 0 && end < css.length; end++) {
      if (css[end] === '(') depth++
      if (css[end] === ')') depth--
    }
    out += `${css.slice(copiedUpTo, match.index)}var(${match[1]})`
    copiedUpTo = fallbackStart.lastIndex = end
  }
  return out + css.slice(copiedUpTo)
}

/** Rules Tailwind generated into `@layer utilities`, in emitted order. Rules
 *  index.css authors by hand are left out: `@reference` never re-emits them,
 *  so they must outrank a single class on their own (as `.bullet.page-bullet`
 *  does). */
const generatedUtilityRules = (root: Root): UtilityRule[] => {
  const rules: UtilityRule[] = []
  root.walkAtRules('layer', layer => {
    if (layer.params !== 'utilities') return
    layer.each(node => {
      if (node.type === 'rule' && node.source?.input.file !== appStylesheet) {
        rules.push({selector: node.selector, css: withoutVarFallbacks(node.toString())})
      }
    })
  })
  return rules
}

describe('extension-utilities.css', () => {
  // The safelist lands after index.css in the same `utilities` layer, so it
  // wins every specificity tie. It leaves the app's cascade intact only by
  // re-emitting the app's utilities with the same bodies in the same relative
  // order: one it lacks or reorders loses to a safelisted utility it emits
  // later (an app `@md:flex-row` to a safelisted `flex-col`).
  it('re-emits every utility index.css generates, with the same bodies, in the same order', async () => {
    const app = generatedUtilityRules(await compile(appStylesheet))
    const appSelectors = new Set(app.map(rule => rule.selector))
    const safelist = generatedUtilityRules(await compile(safelistStylesheet))

    expect(safelist.filter(rule => appSelectors.has(rule.selector))).toEqual(app)
  }, 20_000) // ~0.5s alone; two full Tailwind compiles and a content scan.
})
