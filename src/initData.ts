import { v4 as uuidv4 } from 'uuid'
import { typeProp, rendererProp, aliasProp, fromList } from '@/data/properties'
import type { Repo } from '@/data/repo'
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

// Creates a parent-less Tutorial page carrying intro text + a sample
// renderer-bound block + the example-extensions subtree. Used by the
// personal-workspace bootstrap; reachable from the landing daily note
// via a `[[Tutorial]]` bullet that App.tsx prepends on first run.
// Returns the tutorial page id so callers can navigate to it if they
// want a tutorial-first landing.
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
