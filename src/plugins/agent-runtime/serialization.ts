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

export const serializeValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
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
      data: serializeValue(value.peek(), seen),
    }
  }

  if (Array.isArray(value)) {
    return value.map(item => serializeValue(item, seen))
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)

    if (value instanceof Map) {
      return Object.fromEntries(
        Array.from(value.entries()).map(([key, mapValue]) => [
          String(key),
          serializeValue(mapValue, seen),
        ]),
      )
    }

    if (value instanceof Set) {
      return Array.from(value.values()).map(item => serializeValue(item, seen))
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, objectValue]) => [
        key,
        serializeValue(objectValue, seen),
      ]),
    )
  }

  return String(value)
}
