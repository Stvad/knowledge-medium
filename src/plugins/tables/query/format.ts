/** The saved form of parsed terms: every property and type addressed by id
 *  (`name^fieldId`, `#label^typeId`), its current name kept as decoration, so
 *  a rename leaves the saved text pointing at the same definition. Parsing the
 *  saved form gives back the same terms. */
import { OP_TEXT, type Operand, type QueryProperty, type QueryTerm, type QueryType } from './parse'

const BARE = /^[^\s"|()!=<>#^[\]]+$/

const quote = (text: string) => `"${text.replace(/[\\"]/g, ch => `\\${ch}`)}"`
const word = (text: string) => BARE.test(text) ? text : quote(text)

const propertyKey = (property: QueryProperty) => `${word(property.name)}^${property.fieldId}`
const typeRef = (type: QueryType) => `#${word(type.label)}^${type.id}`
const operandText = (operand: Operand) => operand.kind === 'ref' ? operand.spelling : word(operand.value)

export const formatTerm = (term: QueryTerm): string => {
  switch (term.kind) {
    case 'types': return `${term.negated ? '!' : ''}${term.types.map(typeRef).join('|')}`
    case 'compare': return `${propertyKey(term.property)}${OP_TEXT[term.op]}${operandText(term.operand)}`
    case 'presence': return `${term.present ? '' : '!'}${propertyKey(term.property)}`
    case 'field': return `${term.field}${OP_TEXT[term.op]}${term.operand}`
    case 'refs': case 'under': return `${term.kind}=${term.target.spelling}`
    case 'childof': return `childof=${term.target === 'self' ? 'self' : term.target.spelling}`
    case 'anyOf': return term.alternatives.map(formatTerm).join(' | ')
  }
}

export const formatQuery = (terms: readonly QueryTerm[]): string => terms.map(formatTerm).join(' ')
