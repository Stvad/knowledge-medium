agent extensions (the root AGENTS.md data-model rules apply first; keep this file under ~2KB, it shares Codex's AGENTS.md budget with the root):

installing:
- `install-extension` REFUSES an update that changes which codec a value preset id resolves to on this device. That would re-type every stored value under the preset with nothing migrating them. Fix: a NEW preset id with the definitions repointed (`core.migratePropertyDefinition` fans that out); `--allow-preset-change` only when the values are disposable. The check has blind spots (it misses `enable-extension`, and a parse change under an unchanged `type` string), so bump the codec's `type` string whenever its encoding moves. Full semantics: "Preset-change refusals on install" in `packages/agent-cli/README.md`.
- an install reports `running`; source nothing executes registers no schemas, so writes land raw. Then `pnpm agent audit-extension <label>` checks the data, and `--verify` lints the source.

verifying:
- `pnpm run check` doesn't typecheck this directory: use `npx tsc --noEmit -p agent-extensions/tsconfig.flat.json`. A `baseUrl` in a config of your own makes tsc fail on the config, which reads as a clean run. The gate does run flat-file tests; probes go in `tmp/` or a gitignored `*.probe.*`. A new subpackage gets no CI until it is added to `run-tests.yml`.
- a green test doesn't prove the installed module loads (the app resolves `@/…` through the importmap, exact filenames only), and users run a DB-stored copy: reinstall to ship. An extension importing a NEW kernel export breaks until the app deploys, so deploy first. More: `bd recall reference_agent_extensions_verification`.
- new extension: `pnpm agent new-extension "<Name>" agent-extensions/<slug>`; in this repo, delete its `types/` and `devDependencies` and point tsconfig at `agent-extensions/kernel-types/src/*`.
