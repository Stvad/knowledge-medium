/**
 * It reconstructs the string from its parts (strings and values).
 */

export const reassembleTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): string => {
  // Use reduce to build the string iteratively.
  // The initial value of the accumulator ('result') is the first string part.
  // We then iterate through the *values*, adding the corresponding string part
  // that *follows* the value, and the value itself.
  return values.reduce<string>(
    (result: string, currentValue: unknown, index: number): string => {
      // Append the current value, then the *next* string part.
      // strings[index + 1] is the string part immediately following values[index]
      return result + String(currentValue) + strings[index + 1]
    },
    strings[0], // Start the accumulation with the very first string part.
  )
}

export const reassembleTagProducer = <T>(consumer: (value: string) => T) => (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => consumer(reassembleTag(strings, ...values))
