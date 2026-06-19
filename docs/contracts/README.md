# Contracts

Named, enforced invariants the codebase must uphold — the durable rules, kept
separate from the dated design-doc *snapshots* in `docs/` (which capture a
decision or audit at a point in time and then go stale).

A contract here is expected to be:

- **stated** as a precise property, with the incident history that motivates it;
- **encoded** in code (a runtime chokepoint and/or a shared assertion), not just
  prose, so a regression fails a test rather than silently reappearing;
- **kept current** — if the code changes, the contract doc and its enforcement
  change with it.

| Contract | Enforced by |
| --- | --- |
| [derived-data-add-only](./derived-data-add-only.md) | `reconcileDerived` (runtime) · `assertRefListDeriveIsAddOnly` (test) |
