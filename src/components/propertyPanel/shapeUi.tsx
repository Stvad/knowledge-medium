import type { ComponentType } from 'react'
import {
  Braces,
  Calendar,
  CheckSquare,
  Hash,
  Link as LinkIcon,
  List,
  Type as TypeIcon,
} from 'lucide-react'
import { propertyShapeLabel } from './shapes'

const TYPE_GLYPHS: Record<string, typeof TypeIcon> = {
  number: Hash,
  boolean: CheckSquare,
  list: List,
  date: Calendar,
  object: Braces,
  string: TypeIcon,
  url: LinkIcon,
}

/** Resolves the icon component for a property row, preset picker, or
 *  field-config sheet. The `Glyph` prop wins (used for per-name
 *  `PropertyEditorOverride.Glyph` overrides AND `ValuePreset.Glyph`
 *  contributions threaded through `resolvePropertyDisplay`); falling
 *  back to the codec-type-keyed kernel table for plugin types without
 *  a registered glyph, and finally to the generic text icon. */
export function PropertyShapeGlyph({
  shape,
  Glyph,
  className = '',
}: {
  /** Codec type (open string). Used for the kernel fallback when no
   *  override `Glyph` is supplied. */
  shape: string
  /** Optional override (per-name editor override or preset glyph). */
  Glyph?: ComponentType<{className?: string}>
  className?: string
}) {
  if (Glyph) return <Glyph className={`h-3.5 w-3.5 ${className}`} />
  const Icon = TYPE_GLYPHS[shape] ?? TypeIcon
  return <Icon className={`h-3.5 w-3.5 ${className}`} strokeWidth={1.8} />
}

export function PropertyShapeButton({
  shape,
  Glyph,
  label,
  schemaUnknown,
  decodeFailed = false,
  onClick,
}: {
  shape: string
  Glyph?: ComponentType<{className?: string}>
  label: string
  schemaUnknown: boolean
  decodeFailed?: boolean
  onClick: () => void
}) {
  const tone = decodeFailed
    ? 'text-destructive hover:text-destructive'
    : schemaUnknown
      ? 'text-muted-foreground hover:text-foreground'
      : 'text-fuchsia-500 hover:text-fuchsia-600'

  return (
    <button
      type="button"
      className={`flex h-7 w-5 items-center justify-center rounded-sm ${tone} hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
      title={`Configure ${label} (${propertyShapeLabel(shape)})`}
      aria-label={`Configure ${label}`}
      data-property-config-button="true"
      data-property-row-control="true"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      }}
    >
      <PropertyShapeGlyph shape={shape} Glyph={Glyph} />
    </button>
  )
}
