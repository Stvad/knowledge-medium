when workin in a git repository, unless otherwise stated:
- commit after each requested change
- commit only changes you've done

verification:
- use `yarn run check` for verification unless otherwise stated

secret handling:
- do not read `.env`, `.env.*`, or other local secret files unless the user explicitly asks for it
- do not print, echo, cat, grep, or otherwise reveal secrets or secret-bearing files in chat or command output
- when a task needs secret-backed config, infer variable names from code/docs and have the user provide or set values out of band
- if a command must touch a secret file, avoid outputting its contents and avoid relaying secret values back to the user

agent runtime bridge (`yarn agent`):
- start with `yarn agent runtime-summary` then `yarn agent describe-runtime`. These give you actions, facets, renderers, API surface, authoring guides, and storage patterns. They are the canonical "what's registered / what's available" view.
- for extension authoring, `yarn agent describe-runtime --guide external-sync-plugin --storage` returns step-by-step guidance, code examples (dialog mount, prefs block, deterministic ids), and `afterInstall` notes you should respect.
- `yarn agent install-extension [--verify] [--description "..."] <file> [label]` installs from disk. User extensions are disabled by default — follow with `yarn agent enable-extension <label>` before their actions show up in `run-action`.
- do NOT reach into `facetRuntime.staticContributionsByFacet` / `repo.runtimeContributionBuckets` / similar through `yarn agent eval` to figure out what's registered. Both are internal caches with different shapes (replay cache vs. live registry, both keyed by `facet.id` strings) and are easy to misread. Use `describe-runtime` instead.
- reserve `yarn agent eval` for things `describe-runtime` doesn't cover: live block reads, repo method probing, testing extension code in-place.
