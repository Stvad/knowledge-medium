import { v4 as uuidv4 } from 'uuid'
import { typeProp, rendererProp, aliasProp, fromList } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { dailyPageAliases } from '@/utils/dailyPage'
import { exampleExtensions, TUTORIAL_README } from '@/extensions/exampleExtensions.ts'

export type WorkspaceSeedKind = 'tutorial' | 'daily'

// Each seeder customizes the empty root block that
// create_workspace / ensure_personal_workspace seeded server-side.
// repo.create is UPSERT under the hood, so writing the root with the
// already-known id overwrites whatever's there — whether the seed has
// already synced down or not. Children are fresh blocks parented to the
// existing root. The result is exactly one root in the workspace.

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

const seedTutorial = (repo: Repo, rootBlockId: string, workspaceId: string): void => {
  const introId = uuidv4()
  const sampleId = uuidv4()
  const extensionsParentId = uuidv4()

  // Extension subtree first so we know the ids.
  const extensionIds = seedExtensionBlocks(repo, extensionsParentId, workspaceId)

  repo.create({
    id: extensionsParentId,
    workspaceId,
    parentId: rootBlockId,
    content: 'extensions',
    properties: fromList(aliasProp(['extensions'])),
    childIds: extensionIds,
  })

  repo.create({
    id: introId,
    workspaceId,
    parentId: rootBlockId,
    content: TUTORIAL_README,
  })

  repo.create({
    id: sampleId,
    workspaceId,
    parentId: rootBlockId,
    content: 'A block that uses the hello-renderer extension',
    properties: {renderer: {...rendererProp, value: 'hello-renderer'}},
  })

  repo.create({
    id: rootBlockId,
    workspaceId,
    content: 'Welcome',
    childIds: [introId, sampleId, extensionsParentId],
  })
}

const seedDailyPage = (repo: Repo, rootBlockId: string, workspaceId: string): void => {
  const [dateLabel, dateIso] = dailyPageAliases(new Date())
  // Empty child bullet so the user has somewhere to type without
  // overwriting the page title (the date) on first keystroke.
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

export const seedNewWorkspace = (
  repo: Repo,
  rootBlockId: string,
  workspaceId: string,
  kind: WorkspaceSeedKind,
): void => {
  switch (kind) {
    case 'tutorial':
      seedTutorial(repo, rootBlockId, workspaceId)
      return
    case 'daily':
      seedDailyPage(repo, rootBlockId, workspaceId)
      return
  }
}
