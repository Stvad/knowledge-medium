import type {SVGProps} from 'react'

const IconBase = ({children, ...props}: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns='http://www.w3.org/2000/svg'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='2'
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
    {...props}
  >
    {children}
  </svg>
)

export const SendIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconBase {...props}>
    <path d='m22 2-7 20-4-9-9-4Z' />
    <path d='M22 2 11 13' />
  </IconBase>
)

export const SettingsIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconBase {...props}>
    <path d='M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z' />
    <circle cx='12' cy='12' r='3' />
  </IconBase>
)

export const CheckCircleIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconBase {...props}>
    <circle cx='12' cy='12' r='10' />
    <path d='m9 12 2 2 4-4' />
  </IconBase>
)

export const AlertCircleIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconBase {...props}>
    <circle cx='12' cy='12' r='10' />
    <path d='M12 8v4' />
    <path d='M12 16h.01' />
  </IconBase>
)

export const ExternalLinkIcon = (props: SVGProps<SVGSVGElement>) => (
  <IconBase {...props}>
    <path d='M15 3h6v6' />
    <path d='M10 14 21 3' />
    <path d='M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' />
  </IconBase>
)
