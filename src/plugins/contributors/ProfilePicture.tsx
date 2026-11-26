import type {Block} from '@/data/block'
import {typesProp} from '@/data/properties'
import {safeDecodeRowProperty} from '@/data/rowProperty'
import {useHandle} from '@/hooks/block'
import {getAssetResolver} from '@/plugins/attachments/assetResolver'
import {isImageMime, MEDIA_TYPE, mediaHashOf, mediaMimeProp} from '@/plugins/attachments/mediaBlock'
import {useAssetObjectUrl, type AssetUrlArgs} from '@/plugins/attachments/useAssetObjectUrl'

const ResolvedPicture = ({asset}: {asset: AssetUrlArgs}) => {
  const [state, reportDecodeFailure] = useAssetObjectUrl(asset, getAssetResolver())
  if (state.status !== 'ready') return null
  return <img alt="" className="absolute inset-0 size-full bg-inherit object-cover" src={state.url} onError={() => reportDecodeFailure(state.url)} />
}

export const ProfilePicture = ({block, pictureId, workspaceId}: {
  block: Block
  pictureId: string
  workspaceId: string
}) => {
  const asset = useHandle(block.repo.block(pictureId), {
    selector: row => {
      if (!row || row.workspaceId !== workspaceId || !safeDecodeRowProperty(row, typesProp).includes(MEDIA_TYPE)) return null
      const mime = safeDecodeRowProperty(row, mediaMimeProp)
      const contentHash = mediaHashOf(row.properties)
      return isImageMime(mime) && contentHash ? {workspaceId, contentHash, mime} : null
    },
  })
  return asset ? <ResolvedPicture asset={asset} /> : null
}
