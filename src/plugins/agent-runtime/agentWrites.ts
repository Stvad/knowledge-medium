import { ChangeScope, type Mutator } from '@/data/api'
import type { Repo } from '@/data/repo'

/** Attribution of agent-bridge writes. `command_events.source` is `'user'` for
 *  every local tx, so an agent write is told apart only by its description:
 *  every tx a bridge verb opens takes its options from {@link agentTxOptions},
 *  and the change-history views filter on this prefix.
 *
 *  Not attributed: `eval`, `sql execute` and `run-action` (arbitrary code), a
 *  Journal page bootstrapped on the way to a first daily note, and the
 *  follow-up txs post-commit processors open for an agent write. */
export const AGENT_TX_DESCRIPTION_PREFIX = 'agent runtime '

export const agentTxOptions = (verb: string) => ({
  scope: ChangeScope.BlockDefault,
  description: `${AGENT_TX_DESCRIPTION_PREFIX}${verb}`,
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
