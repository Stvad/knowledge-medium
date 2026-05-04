import { BulletDot } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { useIsMobile } from '@/utils/react.tsx'

interface BlockLoadingPlaceholderProps {
  reservedHeight: number
}

/**
 * Mirrors the default block flex shape so lazy content slots into the
 * same visual frame instead of materializing from an empty gap.
 */
export function BlockLoadingPlaceholder({
  reservedHeight,
}: BlockLoadingPlaceholderProps) {
  const isMobile = useIsMobile()

  return (
    <div
      className="tm-block relative flex items-start gap-1"
      style={{minHeight: reservedHeight}}
      aria-hidden
    >
      <div className="block-controls flex items-center">
        {!isMobile && <span className="h-6 w-3" />}
        <span className="bullet-link flex items-center justify-center h-6 w-5">
          <BulletDot />
        </span>
      </div>
      <div className="block-body flex-grow" />
    </div>
  )
}
