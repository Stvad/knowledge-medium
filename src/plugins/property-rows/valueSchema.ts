import {isRefCodec, memberCodecOf, type AnyPropertySchema} from '@/data/api'

/** A value row represents one member of a list, or the scalar itself. */
export const propertyValueCodec = (schema: AnyPropertySchema) => memberCodecOf(schema.codec) ?? schema.codec

export const propertyValueTargetTypes = (schema: AnyPropertySchema): readonly string[] => {
  const codec = propertyValueCodec(schema)
  return isRefCodec(codec) ? codec.targetTypes : []
}
