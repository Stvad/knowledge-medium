import { Block } from '@/data/block'

export const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    name: 'Error',
    message: String(error),
  }
}

/** `seen` holds every object, Map and Set already entered anywhere; a second
 *  sighting of one reads as `[Circular]`, so a densely shared graph (a live
 *  repo object) serializes in its size, not in its number of paths.
 *  `arrayPath` holds only the arrays enclosing the current value, so an array
 *  shared without a cycle (a property's default list) is serialized at every
 *  sighting (objects inside it still follow `seen`), and only an array that
 *  reaches itself reads as `[Circular]`. Accepted: arrays of arrays shared as a
 *  DAG serialize once per path. */
export const serializeValue = (
  value: unknown,
  seen = new WeakSet<object>(),
  arrayPath = new WeakSet<unknown[]>(),
): unknown => {
  if (value === undefined) {
    return {type: 'undefined'}
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`
  }

  if (value instanceof Error) {
    return serializeError(value)
  }

  if (value instanceof Block) {
    return {
      type: 'Block',
      id: value.id,
      data: serializeValue(value.peek(), seen, arrayPath),
    }
  }

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      if (arrayPath.has(value)) return '[Circular]'
      arrayPath.add(value)
      const items = value.map(item => serializeValue(item, seen, arrayPath))
      arrayPath.delete(value)
      return items
    }

    if (seen.has(value)) return '[Circular]'
    seen.add(value)

    if (value instanceof Map) {
      return Object.fromEntries(
        Array.from(value.entries()).map(([key, mapValue]) => [
          String(key),
          serializeValue(mapValue, seen, arrayPath),
        ]),
      )
    }

    if (value instanceof Set) {
      return Array.from(value.values()).map(item => serializeValue(item, seen, arrayPath))
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, objectValue]) => [
        key,
        serializeValue(objectValue, seen, arrayPath),
      ]),
    )
  }

  return String(value)
}
