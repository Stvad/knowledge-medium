# Cloud / remote sessions — operational runbook

> **Status:** operational runbook (not a design doc). Last verified 2026-08-19 against bd 1.2.2 and Claude Code cloud containers (PRs #578–#580).

Applies to Claude Code on the web and any other fresh-clone remote container. A local **worktree is not a cloud session** — worktrees share the main checkout's git objects and beads DB and need none of this.

## Git history lies in a shallow clone

- The checkout is a SHALLOW clone with several parentless graft boundaries (`git rev-parse --is-shallow-repository` → true). `git log --follow` and `--diff-filter=A` will confidently name a graft boundary as "the commit that added this file", and that boundary's message is just whatever sat at the cut — so history answers derived from the local clone are wrong in a way that reads authoritative.
- For "when was this added / was it always shaped this way", use the GitHub API: `list_commits` with `path`, then `get_file_contents` with the returned `sha`.
- Bash `rg`/`grep` output here can render the matched identifier incorrectly (a real `import { remarkBlockrefs } from './remark-blockrefs.ts'` came back as `import { ln } from './ln.ts'`). Use the Grep tool for content search, and read the file before relying on any identifier or path seen only in bash grep output.

## beads: the tracker LOOKS empty and is not

A fresh container has no `bd` binary and no data, and the FIRST `bd` command auto-creates an empty local DB — which then refuses to pull ("histories have diverged"). Do not conclude the tracker is empty: it has 200+ issues. Sequence:

1. Install `bd`: `curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash`, then add `/root/go/bin` to PATH.
2. Attach `Stvad/knowledge-medium-beads` to the session (it is outside the default GitHub scope).
3. `bd bootstrap --yes` BEFORE any command that opens the database — only move `.beads/embeddeddolt` aside if something already created it.

`bd bootstrap` needs no config change: the tracked `sync.remote` is an `ssh://` URL and the proxy injects an `insteadOf` that rewrites it to HTTPS. Do not edit `.beads/config.yaml` or `.beads/metadata.json` to "fix" the URL — both are TRACKED, and committing a rewritten remote is what `6dca4d4` had to revert.

## beads: reads and mutations work; `bd dolt push` does not

Reads, issue mutations and `bd remember` all work locally against the cloned DB (verified end to end: create/update/comment/close/delete). Only the sync out is blocked: `bd dolt push` gets HTTP 403 at `addTableFiles, updateManifestAddFiles`. A PAT does NOT help — the agent proxy REPLACES the client's `Authorization` header rather than filling in a missing one, so a self-supplied credential is inert (measured, #578).

**Route around dolt's push instead of trying to fix it**: plain `git push` from a cloud session is unaffected — a normal ref and a 4.8MB pack both land, measured with the pack confirmed on the wire — so:

1. `bd backup init <dir> && bd backup sync` (full fidelity — issues, memories, history — ~5MB, <1s),
2. commit that directory and `git push` it to the PRIVATE beads repo on a `cloud-handoff-*` branch,
3. `bd backup restore` it from a real machine.

`bd backup init` drops `.beads/dolt-backup*.json`, untracked but NOT gitignored — `bd backup remove` when done, and never `git add -A`.

### Prefer the tracked JSONL when only issues need to travel

`bd backup` carries everything and costs a private-repo detour. For the common case — a session that filed or updated some issues — `.beads/issues.jsonl` is tracked and not gitignored, so the session's normal `git push` to the main repo carries them:

1. `bd export -o .beads/issues.jsonl` and commit it with your other work,
2. on any other machine, `git pull` then **`bd import`** with NO arguments — it defaults to that path and upserts (new issues created, existing updated), so a partial or stale file is safe.

What this does NOT carry: Dolt history and branches, and memories — `bd export` excludes memories by default and MUST keep doing so, since this file lands on the PUBLIC repo (never pass `--all` / `--include-memories` when writing it). Use `bd backup` when history or memories actually need to travel.

Do not expect the git hooks to do it for you: `bd hooks run post-merge` does NOT import a changed JSONL. Measured — appended a synthetic record, ran the hook, watched it never reach the DB — so this is one bare command on the receiving side, not zero.

## A push probe proves nothing until you see the pack move

Ref deletion 403s here with or without a PAT and no MCP tool deletes a branch, so the temptation is a throwaway probe made safe with `--atomic` plus a poison-pill refspec. That shape is a TRAP: if the client rejects the poison locally (a non-fast-forward, or any ref whose remote object you lack — "fetch first"), `--atomic` aborts in `send-pack` and **no bytes are ever sent**. It reports `atomic push failed for ref …. status: 5`, which is git's own `REF_STATUS_REJECT_FETCH_FIRST`, not a server reply — so a probe that tested nothing reads exactly like a probe that passed. Always push with `--progress` and require `Writing objects: 100% … done.` before believing any conclusion about what the remote accepts.

## The Dolt remote registry self-adopts git origin in every fresh clone

`bd dolt push` reads `bd dolt remote list`, not the `sync.remote` config key. With the registry empty it silently ADOPTS git origin — in a non-TTY agent shell it does this with no prompt, which is how beads data briefly landed on the public repo during setup. The registry lives in gitignored `.beads/embeddeddolt/`, so a fresh CLONE starts empty and will re-adopt the public origin on first push. In a new clone, run this BEFORE any `bd dolt push`:

```bash
bd dolt remote add origin git+ssh://git@github.com/Stvad/knowledge-medium-beads.git
```

and prefer `BD_NO_REMOTE_ADOPT=1 bd dolt push` so a missing registry fails loudly instead of adopting. (AGENTS.md carries the short form of this rule; it applies to any new machine, not just cloud.)
