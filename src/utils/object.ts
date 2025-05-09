/**
 * Removes all properties with undefined values from an object
 * @param obj The object to filter
 * @returns A new object with all undefined properties removed
 */
export const removeUndefined = <T extends object>(obj: T): Partial<T> => (Object.fromEntries(
  Object.entries(obj).filter(([, value]) => value !== undefined)
) as Partial<T>)

