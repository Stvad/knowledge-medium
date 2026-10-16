import { ChangeScope, type Mutator } from '@/data/api'
import type { Repo } from '@/data/repo'

/** Attribution of agent-bridge writes. `command_events.source` is `'user'` for
 *  every local tx, so an agent write is told apart only by its description:
 *  every tx a bridge verb opens takes its options from {@link agentTxOptions},
 *  and the change-history views filter on this prefix.
 *
 *  Not attributed: `eval`, `sql execute` and `run-action` (arbitrary code), the
 *  daily note `getOrCreateDailyNote` creates (its txs take no description), and
 *  the follow-up txs post-commit processors open for an agent write. */
export const AGENT_TX_DESCRIPTION_PREFIX = 'agent runtime '

export const agentTxOptions = (verb: string) => ({
  scope: ChangeScope.BlockDefault,
  description: `${AGENT_TX_DESCRIPTION_PREFIX}${verb}`,
})

/** `repo.mutate[name](args)`, but in an agent-attributed tx — a mutator
 *  dispatch otherwise describes the tx with the mutator's own `describe`. */
export const runAgentMutator = <Args, R>(
  repo: Repo,
  verb: string,
  mutator: Mutator<Args, R>,
  args: Args,
): Promise<R> =>
  repo.tx(tx => tx.run(mutator, mutator.argsSchema.parse(args)), agentTxOptions(verb))
