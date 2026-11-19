import {isRefCodec, type AnyPropertySchema} from '@/data/api'
import {valueChildCodec} from '@/data/propertyChildren'

export const propertyValueTargetTypes = (schema: AnyPropertySchema): readonly string[] => {
  const codec = valueChildCodec(schema)
  return isRefCodec(codec) ? codec.targetTypes : []
}
