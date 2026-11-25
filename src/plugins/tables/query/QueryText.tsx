import type { PropertyEditorProps } from '@/data/api'

/** Render query syntax literally, including punctuation inside quoted values. */
export const QueryText = ({value}: PropertyEditorProps<string>) =>
  <code className="block min-h-[1.7em] whitespace-pre-wrap break-words font-mono text-sm">{value}</code>
