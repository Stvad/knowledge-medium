import { v4 as uuidv4 } from 'uuid'
import { typeProp, rendererProp, aliasProp, fromList } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { dailyPageAliases } from '@/utils/dailyPage'
import { exampleExtensions, TUTORIAL_README } from '@/extensions/exampleExtensions.ts'

const seedExtensionBlocks = (
  repo: Repo,
  parentId: string,
  workspaceId: string,
): string[] =>
  exampleExtensions.map(({source}) => {
    const id = uuidv4()
    repo.create({
      id,
      workspaceId,
      parentId,
      content: source,
      properties: {type: {...typeProp, value: 'extension'}},
    })
    return id
  })

// Seeds today's date as the content/aliases of an existing block id.
// `rootBlockId` is supplied by create_workspace, which derives it as
// uuid_generate_v5(DAILY_NOTE_NS, workspace_id || ':' || today_iso) so
// it lines up with what client-side dailyNoteBlockId() computes.
// repo.create is UPSERT — writing with the known id overwrites the
// empty seed whether or not sync has delivered it yet.
export const seedDailyPage = (
  repo: Repo,
  rootBlockId: string,
  workspaceId: string,
): void => {
  const [dateLabel, dateIso] = dailyPageAliases(new Date())
  // Empty child bullet so the user has somewhere to type without
  // overwriting the page title on first keystroke.
  const childBlock = repo.create({
    workspaceId,
    parentId: rootBlockId,
    content: '',
  })
  repo.create({
    id: rootBlockId,
    workspaceId,
    content: dateLabel,
    properties: fromList(aliasProp([dateLabel, dateIso])),
    childIds: [childBlock.id],
  })
}

// Creates a separate parent-less Tutorial root carrying intro text +
// a sample renderer-bound block + the example-extensions subtree.
// Distinct from the workspace's daily-note seed root so the tutorial
// doesn't squat on the deterministic daily-note id and confuse later
// `getOrCreateDailyNote` resolution. Returns the tutorial root id so
// callers can navigate to it if they want a tutorial-first landing.
export const seedTutorial = (repo: Repo, workspaceId: string): string => {
  const tutorialRootId = uuidv4()
  const introId = uuidv4()
  const sampleId = uuidv4()
  const extensionsParentId = uuidv4()

  // Extension subtree first so we know the ids.
  const extensionIds = seedExtensionBlocks(repo, extensionsParentId, workspaceId)

  repo.create({
    id: extensionsParentId,
    workspaceId,
    parentId: tutorialRootId,
    content: 'extensions',
    properties: fromList(aliasProp(['extensions'])),
    childIds: extensionIds,
  })

  repo.create({
    id: introId,
    workspaceId,
    parentId: tutorialRootId,
    content: TUTORIAL_README,
  })

  repo.create({
    id: sampleId,
    workspaceId,
    parentId: tutorialRootId,
    content: 'A block that uses the hello-renderer extension',
    properties: {renderer: {...rendererProp, value: 'hello-renderer'}},
  })

  repo.create({
    id: tutorialRootId,
    workspaceId,
    content: 'Tutorial',
    properties: fromList(aliasProp(['Tutorial'])),
    childIds: [introId, sampleId, extensionsParentId],
  })

  return tutorialRootId
}
