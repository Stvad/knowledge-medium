import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useState, type ImgHTMLAttributes, type MouseEvent } from 'react'
import { cn } from '@/lib/utils.js'

export type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  node?: unknown
}

export const MarkdownImage = ({
  src,
  alt,
  className,
  onClick,
  node: _node,
  ...rest
}: MarkdownImageProps) => {
  void _node
  const [open, setOpen] = useState(false)

  if (!src) {
    return <img alt={alt} className={className} onClick={onClick} {...rest}/>
  }

  const handleClick = (event: MouseEvent<HTMLImageElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    setOpen(true)
  }

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) setOpen(false)
  }

  return (
    <>
      <img
        {...rest}
        src={src}
        alt={alt}
        className={cn('cursor-zoom-in', className)}
        onClick={handleClick}
      />
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85"/>
          <DialogPrimitive.Content
            className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 outline-none"
            onClick={handleBackdropClick}
            aria-describedby={undefined}
          >
            <DialogPrimitive.Title className="sr-only">
              {alt || 'Image preview'}
            </DialogPrimitive.Title>
            <img
              src={src}
              alt={alt}
              className="max-h-full max-w-full object-contain cursor-zoom-out"
              onClick={() => setOpen(false)}
            />
            <DialogPrimitive.Close
              className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white opacity-80 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/60"
              aria-label="Close image preview"
            >
              <X className="h-5 w-5"/>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  )
}
