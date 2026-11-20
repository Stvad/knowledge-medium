import { ChangeScope, type Mutator } from '@/data/api'
import type { Repo } from '@/data/repo'

/** Attribution of agent-bridge writes. `command_events.source` is `'user'` for
 *  every local tx, so an agent write is told apart only by its description:
 *  every tx a bridge verb opens takes its options from {@link agentTxOptions},
 *  and the change-history views filter on this prefix.
 *
 *  Not described as agent writes, so not in the change-history views: `eval`,
 *  `sql execute` and `run-action` (arbitrary code), a Journal or Assets page
 *  bootstrapped on the way to its first entry, and the follow-up txs post-commit
 *  processors open for an agent write. */
export const AGENT_TX_DESCRIPTION_PREFIX = 'agent runtime '

/** `undoable: false` keeps the write off the user's undo stack (`skipUndo`):
 *  the caller's write is not the user's action. It stays a `BlockDefault`
 *  document edit otherwise — read-only-gated and attributed to its
 *  contributor; a non-undoable scope would drop both. */
export const agentTxOptions = (verb: string, {undoable = true}: {undoable?: boolean} = {}) => ({
  scope: ChangeScope.BlockDefault,
  description: `${AGENT_TX_DESCRIPTION_PREFIX}${verb}`,
  ...(undoable ? {} : {skipUndo: true}),
})

/** `repo.mutate[name](args)`, but described as an agent write — a mutator
 *  dispatch otherwise describes its tx with the mutator's own `describe`. */
export const runAgentMutator = <Args, R>(
  repo: Repo,
  verb: string,
  mutator: Mutator<Args, R>,
  args: Args,
): Promise<R> =>
  repo.run<R>(mutator.name, args, {description: agentTxOptions(verb).description})
