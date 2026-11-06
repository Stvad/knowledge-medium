/** The Sleep Lab page renderer, selected by the page's own type — same
 *  shape as the Strength Tracker's `StrengthLogRenderer`. The actual content
 *  lives in `LabPageContent`; kept separate so that module can be rendered
 *  in a unit test without this file's `DefaultBlockRenderer` import, which
 *  has no runtime under the kernel-type stubs the unit tier aliases `@/` to.
 */
import {DefaultBlockRenderer} from '@/components/renderer/DefaultBlockRenderer.js'
import {getBlockTypes} from '@/data/properties.js'
import type {BlockRenderer, BlockRendererProps} from '@/types.js'

import {LAB_TYPE} from '../km/fields'
import {LabPageContent} from './LabPageContent'

export const LabPageRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer {...props} ContentRenderer={LabPageContent} EditContentRenderer={LabPageContent}/>
  ),
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      const data = block.peek()
      return !!data && getBlockTypes(data).includes(LAB_TYPE)
    },
    priority: () => 100,
  },
)
LabPageRenderer.displayName = 'LabPageRenderer'
