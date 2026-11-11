import { v4 as uuidv4 } from 'uuid'
import { ChangeScope } from '@/data/api'
import type { Tx } from '@/data/api'
import type { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { keysBetween } from '@/data/orderKey'
import { recaptureAnchor } from '@/plugins/annotations/anchor'
import { createThread } from '@/plugins/annotations/threads'
import {
  EXTENSIONS_PAGE_TITLE,
  extensionsPageOutline,
  tutorialOutline,
  TUTORIAL_DEFAULT_TITLE,
  TUTORIAL_VIM_TITLE,
  type TutorialNode,
  type TutorialThread,
} from './outline'

/**
 * Seeds the starter Tutorial subtree. Three parent-less pages are written in
 * one tx:
 *
 *   - `Tutorial` (default / non-vim variant; the landing target — vim is
 *     off by default, so this matches the shipped keymap)
 *   - `Tutorial (vim)` (variant for users who enable vim mode)
 *   - `extensions` (shared page that holds the explanatory bullets and
 *     the seven example-extension source blocks; both Tutorial variants
 *     link to it via `[[extensions]]` so the examples aren't duplicated)
 *
 * The two Tutorial variants share one outline builder so their
 * structure stays in sync between variants. Reachable from the landing
 * daily note via a `[[Tutorial]]` bullet that the daily-notes landing
 * resolver prepends on first run; the vim variant is reachable from a
 * cross-link bullet at the top of the default Tutorial.
 *
 * The pages share one tx so the subtree appears atomically AND the
 * cross-page wiki links resolve correctly — every alias row exists before
 * `parseReferences` (the post-commit processor) runs against the bullets
 * that reference the other pages. Returns the id of the default Tutorial so
 * callers can use it as a tutorial-first landing target.
 *
 * The comment-thread demos (a node's `thread`) go in after that tx, each in
 * its own, through the annotations plugin's `createThread`: a thread's anchor
 * is checked against its target as committed, and the Comments page is that
 * plugin's to create. They are decoration on a tutorial that already exists,
 * so a failure there is logged rather than thrown — the caller still lands on
 * the page. Deleting the tutorial leaves its threads on the Comments page,
 * shown as on a deleted block: annotations has no target-delete cascade.
 *
 * All of it is one undo step, so undoing right after landing removes the
 * tutorial whole rather than one demo thread at a time.
 *
 * The typed demos (todo / char-counter / word-counter / srs / place / map /
 * html-document) tag themselves against `repo.snapshotTypeRegistries()` — the
 * Repo's live registry. Those plugin types are installed onto the Repo at
 * construction via `staticDataExtensions`, so they're present here even
 * though this runs at bootstrap, before the React app runtime is applied.
 */
export const seedTutorial = (
  repo: Repo,
  workspaceId: string,
): Promise<string> => repo.undoGroup(async repo => {
  const defaultTutorialId = uuidv4()
  const pages: SeedPage[] = [
    { id: uuidv4(), title: TUTORIAL_VIM_TITLE, children: tutorialOutline('vim') },
    { id: defaultTutorialId, title: TUTORIAL_DEFAULT_TITLE, children: tutorialOutline('default') },
    { id: uuidv4(), title: EXTENSIONS_PAGE_TITLE, children: extensionsPageOutline() },
  ]
  // Parent-less pages: their root order keys don't really matter (parent=null
  // means no canonical sibling list) but `tx.create` requires one.
  const orderKeys = keysBetween(null, null, pages.length)
  const context: SeedContext = { workspaceId, threads: [] }

  await repo.tx(
    async tx => {
      for (const [i, page] of pages.entries()) await seedPage(repo, tx, context, page, orderKeys[i])
    },
    { scope: ChangeScope.BlockDefault, description: 'seed tutorial' },
  )

  try {
    for (const thread of context.threads) await seedThread(repo, thread)
  } catch (error) {
    console.error('[onboarding] seeding the tutorial\'s demo comments failed', error)
  }

  return defaultTutorialId
})

interface SeededThread extends TutorialThread {
  targetId: string
  targetContent: string
}

const seedThread = async (
  repo: Repo,
  {targetId, targetContent, quote, comment, replacement}: SeededThread,
): Promise<void> => {
  const anchor = recaptureAnchor(targetContent, targetContent.indexOf(quote), quote)
  if (!anchor) throw new Error(`tutorial thread quote is not plain text of its block: ${quote}`)
  await createThread(repo, {targetId, anchor, comment, replacement}, {description: 'seed tutorial comment'})
}

interface SeedContext {
  workspaceId: string
  /** Collects the nodes' demo threads, written once the pages are committed. */
  threads: SeededThread[]
}

/** A page's title is also its only alias. */
interface SeedPage {
  id: string
  title: string
  children: ReadonlyArray<TutorialNode>
}

const seedPage = async (
  repo: Repo,
  tx: Tx,
  context: SeedContext,
  page: SeedPage,
  orderKey: string,
): Promise<void> => {
  await tx.create({
    id: page.id,
    workspaceId: context.workspaceId,
    parentId: null,
    orderKey,
    content: page.title,
  })
  await repo.addTypeInTx(tx, page.id, PAGE_TYPE, { [aliasesProp.name]: [page.title] })
  await seedChildren(repo, tx, context, page.id, page.children)
}

const seedChildren = async (
  repo: Repo,
  tx: Tx,
  context: SeedContext,
  parentId: string,
  nodes: ReadonlyArray<TutorialNode>,
): Promise<void> => {
  if (nodes.length === 0) return
  const keys = keysBetween(null, null, nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const id = node.id ?? uuidv4()
    await tx.create({
      id,
      workspaceId: context.workspaceId,
      parentId,
      orderKey: keys[i],
      content: node.content,
      properties: node.properties,
    })
    if (node.type) {
      await repo.addTypeInTx(tx, id, node.type, node.typeProperties ?? {})
    }
    if (node.thread) context.threads.push({...node.thread, targetId: id, targetContent: node.content})
    if (node.children && node.children.length > 0) {
      await seedChildren(repo, tx, context, id, node.children)
    }
  }
}
