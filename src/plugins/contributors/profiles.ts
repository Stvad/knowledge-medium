import {ChangeScope, type Tx, type TypeRegistrySnapshot, type User} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {aliasesProp, hasBlockType} from '@/data/properties'
import {assertRoundTrippableReferenceLabel} from '@/data/referenceBlock'
import {ensureUserPageInTx} from '@/data/stateBlocks'
import type {Repo} from '@/data/repo'
import {addTypeInTx} from '@/data/typeTagger'
import {
  CONTRIBUTOR_TYPE, contributorForProp, contributorKindProp, contributorRoleProp,
  type ContributorKind,
} from './schema'

export const ensureHumanContributor = async (tx: Tx, workspaceId: string, user: User, snapshot: TypeRegistrySnapshot): Promise<string> => {
  const id = await ensureUserPageInTx(tx, workspaceId, user, snapshot, {skipMetadata: true})
  const page = await tx.get(id)
  if (!page || !hasBlockType(page, CONTRIBUTOR_TYPE)) {
    await addTypeInTx(tx, snapshot.types, snapshot.propertySchemas, id, CONTRIBUTOR_TYPE,
      {[contributorKindProp.name]: 'human'}, true, {skipMetadata: true})
  }
  return id
}

export const assertContributor = async (tx: Pick<Tx, 'get'>, id: string, workspaceId: string): Promise<void> => {
  const profile = await tx.get(id)
  if (!profile || profile.deleted || profile.workspaceId !== workspaceId || !hasBlockType(profile, CONTRIBUTOR_TYPE)) {
    throw new Error(`Contributor ${id} must be a live Contributor profile in this workspace.`)
  }
}

export interface ContributorProfile {
  id: string
  name: string
  kind: ContributorKind
  role?: string
  workspaceId: string
}

export const createContributor = async (
  repo: Repo,
  workspaceId: string,
  input: {name: string; kind?: ContributorKind; role?: string},
): Promise<ContributorProfile> => {
  const name = input.name.trim()
  if (!name) throw new Error('Contributor name must not be empty.')
  assertRoundTrippableReferenceLabel(name, 'Contributor name')
  const id = crypto.randomUUID()
  const kind = input.kind ?? 'agent'
  const role = input.role?.trim() || undefined
  const snapshot = repo.snapshotTypeRegistries()
  await repo.withTxContext({contributorId: null}).tx(async tx => {
    if (await tx.aliasLookup(name, workspaceId)) throw new Error(`A page named ${name} already exists; choose a different contributor name or tag that page as a Contributor profile.`)
    const actingFor = await ensureHumanContributor(tx, workspaceId, repo.user, snapshot)
    await tx.create({id, workspaceId, parentId: null, orderKey: 'a0', content: name})
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: [name]}, snapshot)
    await repo.addTypeInTx(tx, id, CONTRIBUTOR_TYPE, {[contributorKindProp.name]: kind}, snapshot)
    if (role) await tx.setProperty(id, contributorRoleProp, role)
    if (kind !== 'human') await tx.setProperty(id, contributorForProp, actingFor)
  }, {scope: ChangeScope.BlockDefault, description: `Create contributor ${name}`})
  return {id, name, kind, role, workspaceId}
}

export const listContributors = async (repo: Repo, workspaceId: string): Promise<{contributors: ContributorProfile[]}> => {
  const rows = await repo.db.getAll<{id: string}>(
    `SELECT b.id FROM blocks b JOIN block_types t ON t.block_id = b.id
      WHERE b.workspace_id = ? AND b.deleted = 0 AND t.type = ? ORDER BY b.content, b.id`,
    [workspaceId, CONTRIBUTOR_TYPE],
  )
  const contributors: ContributorProfile[] = []
  for (const {id} of rows) {
    const row = await repo.load(id)
    if (!row) continue
    contributors.push({id, name: row.content, workspaceId,
      kind: contributorKindProp.codec.decode(row.properties[contributorKindProp.name] ?? 'agent'),
      role: contributorRoleProp.codec.decode(row.properties[contributorRoleProp.name] ?? null)})
  }
  return {contributors}
}
