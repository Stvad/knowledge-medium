import type { Codec } from './codecs'

/** Data-only half of a value preset. Safe to import from the kernel, CLI,
 * bridge, and projector code without pulling in React presentation. */
export interface ValuePresetCore<TValue = unknown, TConfig = void> {
  /** Stable id persisted on property-schema definition blocks. */
  readonly id: string
  /** Deterministic codec factory, called only with validated config. */
  readonly build: (config: TConfig) => Codec<TValue>
  readonly defaultValue: TValue
  readonly defaultConfig?: TConfig
  readonly configCodec?: Codec<TConfig>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyValuePresetCore = ValuePresetCore<any, any>

export const definePresetCore = <TValue = unknown, TConfig = void>(
  core: ValuePresetCore<TValue, TConfig>,
): ValuePresetCore<TValue, TConfig> => core
