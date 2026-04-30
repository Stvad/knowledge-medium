import { v4 as uuidv4 } from 'uuid'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/internals/repo'
import { typeProp, rendererProp, aliasesProp } from '@/data/properties'
import { exampleExtensions, TUTORIAL_README } from '@/extensions/exampleExtensions.ts'

/** Creates a parent-less Tutorial page carrying intro text + a sample
 *  renderer-bound block + the example-extensions subtree. Used by the
 *  personal-workspace bootstrap; reachable from the landing daily
 *  note via a `[[Tutorial]]` bullet that App.tsx prepends on first
 *  run. Returns the tutorial page id so callers can navigate to it
 *  if they want a tutorial-first landing.
 *
 *  All inserts run in one `repo.tx` so the whole tutorial subtree
 *  appears atomically. Order keys are simple incrementing letters
 *  (`a0`, `a1`, ...) — fine for seed data, no need for fractional
 *  indexing here. */
export const seedTutorial = async (repo: Repo, workspaceId: string): Promise<string> => {
  const tutorialRootId = uuidv4()
  const introId = uuidv4()
  const sampleId = uuidv4()
  const extensionsParentId = uuidv4()
  const extensionIds = exampleExtensions.map(() => uuidv4())

  await repo.tx(async tx => {
    // Tutorial root.
    await tx.create({
      id: tutorialRootId,
      workspaceId,
      parentId: null,
      orderKey: 'a0',
      content: 'Tutorial',
      properties: {[aliasesProp.name]: aliasesProp.codec.encode(['Tutorial'])},
    })

    // First child of root: intro README.
    await tx.create({
      id: introId,
      workspaceId,
      parentId: tutorialRootId,
      orderKey: 'a0',
      content: TUTORIAL_README,
    })

    // Second child: sample renderer block.
    await tx.create({
      id: sampleId,
      workspaceId,
      parentId: tutorialRootId,
      orderKey: 'a1',
      content: 'A block that uses the hello-renderer extension',
      properties: {[rendererProp.name]: rendererProp.codec.encode('hello-renderer')},
    })

    // Third child: extensions parent.
    await tx.create({
      id: extensionsParentId,
      workspaceId,
      parentId: tutorialRootId,
      orderKey: 'a2',
      content: 'extensions',
      properties: {[aliasesProp.name]: aliasesProp.codec.encode(['extensions'])},
    })

    // Each example extension block as a child of `extensionsParentId`.
    for (let i = 0; i < exampleExtensions.length; i++) {
      const {source} = exampleExtensions[i]
      await tx.create({
        id: extensionIds[i],
        workspaceId,
        parentId: extensionsParentId,
        orderKey: `a${i}`,
        content: source,
        properties: {[typeProp.name]: typeProp.codec.encode('extension')},
      })
    }
  }, {scope: ChangeScope.BlockDefault, description: 'seed tutorial'})

  return tutorialRootId
}
