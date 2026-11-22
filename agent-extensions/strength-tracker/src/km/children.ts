import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'

/** A block's children without its property rows: the rows a session, plan or
 *  settings outline is made of. Typed here because the extension type stubs
 *  leave `repo.query.*` results untyped. */
export const contentChildren = async (repo: Repo, id: string): Promise<BlockData[]> =>
  (await repo.query.children({id, propertyChildren: 'none'}).load()) ?? []
