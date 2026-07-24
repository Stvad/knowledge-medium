import { useMedia } from 'react-use'
import { MOBILE_BREAKPOINT_QUERY } from './viewport.js'

export const useIsMobile = () => {
  return useMedia(MOBILE_BREAKPOINT_QUERY, false);
}

/** Whether the PRIMARY pointing device is coarse (touch/stylus) — i.e. a
 *  phone, tablet, or a convertible in tablet mode. Reads `false` on desktops,
 *  laptops, and touch laptops / convertibles in laptop mode, where the primary
 *  pointer is a mouse/trackpad (`fine`) even if a touchscreen is also present.
 *  Reactive: attaching a mouse can flip the primary pointer to fine. */
export const usePointerCoarse = () => {
  return useMedia('(pointer: coarse)', false);
}
