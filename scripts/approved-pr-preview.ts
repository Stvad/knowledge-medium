import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

type PullRequest = {
  number: number
  state: string
  base: { ref: string; repo: { full_name: string } }
  head: { sha: string; repo: { full_name: string } | null }
}

export function parsePrNumber(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('PR number must be a canonical positive integer')
  }
  return Number(value)
}

export async function approvePreview({ prNumber, headSha, repository, getPull }: {
  prNumber: string
  headSha: string
  repository: string
  getPull: (number: number) => Promise<PullRequest>
}) {
  const number = parsePrNumber(prNumber)
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('Approval requires a full lowercase 40-character commit SHA')
  }
  const pr = await getPull(number)
  if (pr.number !== number) throw new Error('Response does not match the requested PR')
  if (pr.base.repo.full_name !== repository) throw new Error('PR has a different target repository')
  if (pr.state !== 'open') throw new Error('PR must still be open')
  if (pr.base.ref !== 'master') throw new Error('PR must target master')
  if (pr.head.sha !== headSha) throw new Error('PR head has changed; review and approve the new SHA')
  if (!pr.head.repo) throw new Error('PR head repository is unavailable')
  return {
    number,
    sha: headSha,
    repository: pr.head.repo.full_name,
    basePath: `/${repository.split('/')[1]}/pr-preview/pr-${number}/`,
  }
}

// The privileged publisher accepts files, never Git metadata or filesystem links.
export function validatePreviewArtifact(directory: string): void {
  function walk(path: string) {
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (/^\.git/i.test(entry)) throw new Error(`Artifact contains Git control data: ${entry}`)
        walk(join(path, entry))
      }
    } else if (!stat.isFile()) {
      throw new Error('Preview artifacts must contain only directories and regular files')
    }
  }
  walk(directory)
  for (const file of ['index.html', 'version.json']) {
    if (!lstatSync(join(directory, file)).isFile()) throw new Error(`Missing build file: ${file}`)
  }
}
