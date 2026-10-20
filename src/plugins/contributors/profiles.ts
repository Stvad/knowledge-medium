import {ChangeScope, type Tx, type TypeRegistrySnapshot, type User} from '@/data/api'
import {hasBlockType} from '@/data/properties'
import {assertRoundTrippableReferenceLabel} from '@/data/referenceBlock'
import {ensureUserPageInTx} from '@/data/stateBlocks'
import type {Repo} from '@/data/repo'
import {applyTypeTagInTx} from '@/data/typeTagger'
import {ensureAliasTarget} from '@/data/targets'
import {resolveAliasSeatNamespaces} from '@/data/aliasSeatNamespace'
import {
  CONTRIBUTOR_TYPE, contributorForProp, contributorKindOf, contributorKindProp, contributorRoleProp,
  type ContributorKind,
} from './schema'

export const ensureHumanContributor = async (tx: Tx, workspaceId: string, user: User, snapshot: TypeRegistrySnapshot): Promise<string> => {
  const id = await ensureUserPageInTx(tx, workspaceId, user, snapshot, {skipMetadata: true})
  const writeOpts = {skipMetadata: true}
  await applyTypeTagInTx(tx, snapshot, {blockId: id, typeId: CONTRIBUTOR_TYPE, writeOpts})
  await tx.setProperty(id, contributorKindProp, 'human', writeOpts)
  return id
}

export const assertContributor = async (
  tx: Pick<Tx, 'get'>, id: string, workspaceId: string, options: {allowHuman?: boolean} = {},
): Promise<void> => {
  const profile = await tx.get(id)
  if (!profile || profile.deleted || profile.workspaceId !== workspaceId || !hasBlockType(profile, CONTRIBUTOR_TYPE)) {
    throw new Error(`Contributor ${id} must be a live Contributor profile in this workspace.`)
  }
  if (options.allowHuman === false && contributorKindOf(profile) === 'human') {
    throw new Error('Agent writes require an agent or automation contributor, not a human profile.')
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
  const kind = input.kind ?? 'agent'
  const role = input.role?.trim() || undefined
  await resolveAliasSeatNamespaces(repo, workspaceId)
  const snapshot = repo.snapshotTypeRegistries()
  const id = await repo.withTxContext({contributorId: null}).tx(async tx => {
    const target = await ensureAliasTarget(tx, repo, name, workspaceId, snapshot, {systemMint: false})
    if (!target.inserted) throw new Error(`A page named ${name} already exists; choose a different contributor name or tag that page as a Contributor profile.`)
    const id = target.id
    const actingFor = await ensureHumanContributor(tx, workspaceId, repo.user, snapshot)
    await repo.addTypeInTx(tx, id, CONTRIBUTOR_TYPE, {[contributorKindProp.name]: kind}, snapshot)
    if (role) await tx.setProperty(id, contributorRoleProp, role)
    if (kind !== 'human') await tx.setProperty(id, contributorForProp, actingFor)
    return id
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
      kind: contributorKindOf(row),
      role: contributorRoleProp.codec.decode(row.properties[contributorRoleProp.name] ?? null)})
  }
  return {contributors}
}
