export interface FacetResolveContext {
  [key: string]: unknown
}

export interface Facet<Input, Output = readonly Input[]> {
  id: string
  combine: (values: readonly Input[], context: FacetResolveContext) => Output
  empty: (context: FacetResolveContext) => Output
  validate?: (value: unknown) => value is Input
  of: (value: Input, options?: FacetContributionOptions) => FacetContribution<Input>
}

export interface FacetContributionOptions {
  precedence?: number
  source?: string
}

export interface FacetContribution<Input> extends FacetContributionOptions {
  type: 'facet-contribution'
  facet: Pick<Facet<Input, unknown>, 'id' | 'validate'>
  value: Input
}

export type AppExtension =
  | FacetContribution<unknown>
  | readonly AppExtension[]
  | ((context: FacetResolveContext) => AppExtension | Promise<AppExtension>)
  | null
  | undefined
  | false

export type FacetFunction = (...args: never[]) => unknown

export const isFunction = <T extends FacetFunction>(
  value: unknown,
): value is T => typeof value === 'function'

export type OptionalContributionResult<T> = T | null | undefined | false

export const resolveLastContributionResult = <Context, Result>(
  contributions: readonly ((context: Context) => OptionalContributionResult<Result>)[],
  context: Context,
  initialValue?: Result,
): Result | undefined => {
  let result = initialValue

  for (const contribution of contributions) {
    const contributionResult = contribution(context)
    if (contributionResult) result = contributionResult
  }

  return result
}

export const combineLastContributionResult =
  <Context, Result>(getInitialValue?: (context: Context) => Result | undefined) =>
    (contributions: readonly ((context: Context) => OptionalContributionResult<Result>)[]) =>
      (context: Context): Result | undefined =>
        resolveLastContributionResult(contributions, context, getInitialValue?.(context))

export function defineFacet<Input, Output = readonly Input[]>({
  id,
  combine,
  empty,
  validate,
}: {
  id: string
  combine?: (values: readonly Input[], context: FacetResolveContext) => Output
  empty?: (context: FacetResolveContext) => Output
  validate?: (value: unknown) => value is Input
}): Facet<Input, Output> {
  const facet: Facet<Input, Output> = {
    id,
    combine: combine ?? ((values) => values as unknown as Output),
    empty: empty ?? (() => [] as unknown as Output),
    validate,
    of: (value, options = {}) => ({
      type: 'facet-contribution',
      facet: facet as unknown as Facet<Input, unknown>,
      value,
      ...options,
    }),
  }

  return facet
}

export class FacetRuntime {
  private readonly contributionsByFacet = new Map<string, FacetContribution<unknown>[]>()
  private readonly cache = new Map<string, unknown>()

  constructor(
    public readonly context: FacetResolveContext,
    contributions: readonly FacetContribution<unknown>[],
  ) {
    for (const contribution of contributions) {
      const bucket = this.contributionsByFacet.get(contribution.facet.id) ?? []
      bucket.push(contribution)
      this.contributionsByFacet.set(contribution.facet.id, bucket)
    }
  }

  read<Input, Output>(facet: Facet<Input, Output>): Output {
    if (this.cache.has(facet.id)) {
      return this.cache.get(facet.id) as Output
    }

    const contributions = this.contributionsByFacet.get(facet.id) ?? []
    if (!contributions.length) {
      const emptyValue = facet.empty(this.context)
      this.cache.set(facet.id, emptyValue)
      return emptyValue
    }

    const values = contributions
      .toSorted((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0))
      .map((contribution) => contribution.value as Input)

    const value = facet.combine(values, this.context)
    this.cache.set(facet.id, value)
    return value
  }

  contributions<Input>(facet: Facet<Input, unknown>): FacetContribution<Input>[] {
    return (this.contributionsByFacet.get(facet.id) ?? []) as FacetContribution<Input>[]
  }
}

export async function resolveFacetRuntime(
  extensions: AppExtension | readonly AppExtension[],
  context: FacetResolveContext = {},
): Promise<FacetRuntime> {
  const contributions: FacetContribution<unknown>[] = []
  await collectContributions(extensions, context, contributions)
  return new FacetRuntime(context, contributions)
}

export function resolveFacetRuntimeSync(
  extensions: AppExtension | readonly AppExtension[],
  context: FacetResolveContext = {},
): FacetRuntime {
  const contributions: FacetContribution<unknown>[] = []
  collectContributionsSync(extensions, contributions)
  return new FacetRuntime(context, contributions)
}

const pushValidatedContribution = (
  contribution: FacetContribution<unknown>,
  output: FacetContribution<unknown>[],
): void => {
  const validate = contribution.facet.validate
  if (validate && !validate(contribution.value)) {
    console.error(
      `Dropping invalid contribution for facet "${contribution.facet.id}"`,
      {source: contribution.source, value: contribution.value},
    )
    return
  }

  output.push(contribution)
}

async function collectContributions(
  extension: AppExtension | readonly AppExtension[],
  context: FacetResolveContext,
  output: FacetContribution<unknown>[],
): Promise<void> {
  if (!extension) return

  if (isExtensionArray(extension)) {
    for (const child of extension) {
      await collectContributions(child, context, output)
    }
    return
  }

  if (typeof extension === 'function') {
    try {
      await collectContributions(await extension(context), context, output)
    } catch (error) {
      console.error('Failed to resolve app extension', error)
    }
    return
  }

  if (extension.type === 'facet-contribution') {
    pushValidatedContribution(extension, output)
  }
}

function collectContributionsSync(
  extension: AppExtension | readonly AppExtension[],
  output: FacetContribution<unknown>[],
): void {
  if (!extension) return

  if (isExtensionArray(extension)) {
    for (const child of extension) {
      collectContributionsSync(child, output)
    }
    return
  }

  if (typeof extension === 'function') {
    throw new Error('Cannot resolve function app extensions synchronously')
  }

  if (extension.type === 'facet-contribution') {
    pushValidatedContribution(extension, output)
  }
}

const isExtensionArray = (
  extension: AppExtension | readonly AppExtension[],
): extension is readonly AppExtension[] => Array.isArray(extension)
