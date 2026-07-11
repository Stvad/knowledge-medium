import {
  definePropertyEditorOverride,
  type PropertyEditorProps,
} from '@/extensions/api.js'
import type {Block} from '@/data/block.js'
import {openDialog, type DialogContextProps} from '@/utils/dialogs.js'
import {showInfo, showSuccess} from '@/utils/toast.js'
import {Button} from '@/components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import {Input} from '@/components/ui/input.js'
import {Label} from '@/components/ui/label.js'
import {useEffect, useState, useSyncExternalStore} from 'react'

import {
  AlertCircleIcon,
  CheckCircleIcon,
  SettingsIcon,
} from './icons'
import {
  clearBlueskyAppPassword,
  clearBufferToken,
  clearLessWrongToken,
  loadConfig,
  loadBlueskyAppPassword,
  loadBufferToken,
  loadLessWrongToken,
  getCredentialSnapshot,
  prefsBlock,
  saveBlueskyAppPassword,
  saveBufferToken,
  saveLessWrongToken,
  subscribeCredentialState,
} from './credentials'
import {
  blueskyConnectedHintProp,
  blueskyHandleProp,
  corsProxyUrlProp,
  lesswrongConnectedHintProp,
  twitterConnectedHintProp,
} from './properties'
import type {PlatformId} from './types'

interface CredentialsDialogProps {
  repo: any
}

export const CredentialsDialog = ({
  repo,
  resolve,
  cancel,
}: DialogContextProps<boolean> & CredentialsDialogProps) => {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [bufferToken, setBufferToken] = useState('')
  const [blueskyHandle, setBlueskyHandle] = useState('')
  const [blueskyPassword, setBlueskyPassword] = useState('')
  const [lesswrongToken, setLesswrongToken] = useState('')
  const [corsProxyUrl, setCorsProxyUrl] = useState('')
  const [status, setStatus] = useState({twitter: false, bluesky: false, lesswrong: false})

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const nextConfig = await loadConfig(repo)
      if (cancelled) return
      setBlueskyHandle(nextConfig.blueskyHandle)
      setCorsProxyUrl(nextConfig.corsProxyUrl)
      setStatus({
        twitter: Boolean(nextConfig.bufferToken),
        bluesky: Boolean(nextConfig.blueskyHandle && nextConfig.blueskyAppPassword),
        lesswrong: Boolean(nextConfig.lesswrongToken),
      })
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [repo])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const prefs = await prefsBlock(repo)
      if (prefs) {
        await prefs.set(blueskyHandleProp, blueskyHandle.trim())
        await prefs.set(corsProxyUrlProp, corsProxyUrl.trim())
      }
      if (bufferToken.trim()) saveBufferToken(bufferToken.trim())
      if (blueskyPassword.trim()) saveBlueskyAppPassword(blueskyPassword.trim())
      if (lesswrongToken.trim()) saveLessWrongToken(lesswrongToken.trim())
      showSuccess('Saved social publisher credentials')
      resolve(true)
    } finally {
      setSaving(false)
    }
  }

  const clearDeviceCredentials = async (): Promise<void> => {
    clearBufferToken()
    clearBlueskyAppPassword()
    clearLessWrongToken()
    setBufferToken('')
    setBlueskyPassword('')
    setLesswrongToken('')
    setStatus({twitter: false, bluesky: false, lesswrong: false})
    showInfo('Cleared device-local social publisher credentials')
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) cancel() }}>
      <DialogContent className='max-w-xl'>
        <DialogHeader>
          <DialogTitle>Social Publisher credentials</DialogTitle>
          <DialogDescription>
            Blank secret fields keep the existing local value. Secrets stay on this device.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className='text-sm text-muted-foreground'>Loading credentials...</div>
        ) : (
          <div className='grid gap-4'>
            <div className='grid gap-2'>
              <Label htmlFor='smp-buffer-token'>Buffer API token</Label>
              <Input
                id='smp-buffer-token'
                type='password'
                value={bufferToken}
                placeholder={status.twitter ? 'Configured; leave blank to keep' : 'Buffer API token'}
                onChange={event => setBufferToken(event.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='smp-bluesky-handle'>Bluesky handle</Label>
              <Input
                id='smp-bluesky-handle'
                value={blueskyHandle}
                placeholder='user.bsky.social'
                onChange={event => setBlueskyHandle(event.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='smp-bluesky-password'>Bluesky app password</Label>
              <Input
                id='smp-bluesky-password'
                type='password'
                value={blueskyPassword}
                placeholder={status.bluesky ? 'Configured; leave blank to keep' : 'xxxx-xxxx-xxxx-xxxx'}
                onChange={event => setBlueskyPassword(event.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='smp-lesswrong-token'>LessWrong login token</Label>
              <Input
                id='smp-lesswrong-token'
                type='password'
                value={lesswrongToken}
                placeholder={status.lesswrong ? 'Configured; leave blank to keep' : 'LessWrong loginToken'}
                onChange={event => setLesswrongToken(event.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='smp-cors-proxy'>Optional CORS proxy URL</Label>
              <Input
                id='smp-cors-proxy'
                value={corsProxyUrl}
                placeholder='https://your-cors-proxy.example'
                onChange={event => setCorsProxyUrl(event.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type='button' variant='outline' onClick={clearDeviceCredentials} disabled={saving}>
            Clear local credentials
          </Button>
          <Button type='button' variant='outline' onClick={() => resolve(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type='button' onClick={save} disabled={loading || saving}>
            <SettingsIcon className='mr-2 h-4 w-4' />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const ConnectedHintEditor = ({
  platform,
  block,
}: PropertyEditorProps<boolean> & {platform: PlatformId}) => {
  useSyncExternalStore(
    subscribeCredentialState,
    getCredentialSnapshot,
    getCredentialSnapshot,
  )
  const settingsBlock = block as Block
  const configured = platform === 'twitter'
    ? Boolean(loadBufferToken())
    : platform === 'bluesky'
      ? Boolean(settingsBlock.peekProperty(blueskyHandleProp) && loadBlueskyAppPassword())
      : Boolean(loadLessWrongToken())
  const repo = settingsBlock.repo
  return (
    <div className='flex items-center gap-2'>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          color: configured ? 'var(--foreground)' : 'var(--muted-foreground)',
        }}
      >
        {configured ? <CheckCircleIcon style={{width: 14, height: 14}} /> : <AlertCircleIcon style={{width: 14, height: 14}} />}
        {configured ? 'configured on this device' : 'not configured on this device'}
      </span>
      <Button
        type='button'
        variant='outline'
        size='sm'
        onClick={() => { void openCredentialsDialog(repo) }}
      >
        <SettingsIcon className='mr-2 h-4 w-4' />
        Manage...
      </Button>
    </div>
  )
}

const TwitterConnectedHintEditor = (props: PropertyEditorProps<boolean>) => (
  <ConnectedHintEditor {...props} platform='twitter' />
)

const BlueskyConnectedHintEditor = (props: PropertyEditorProps<boolean>) => (
  <ConnectedHintEditor {...props} platform='bluesky' />
)

const LessWrongConnectedHintEditor = (props: PropertyEditorProps<boolean>) => (
  <ConnectedHintEditor {...props} platform='lesswrong' />
)

export const blueskyHandleEditor = definePropertyEditorOverride<string>({
  name: blueskyHandleProp.name,
  label: 'Bluesky handle',
})

export const corsProxyUrlEditor = definePropertyEditorOverride<string>({
  name: corsProxyUrlProp.name,
  label: 'CORS proxy URL',
})

export const twitterConnectedEditor = definePropertyEditorOverride<boolean>({
  name: twitterConnectedHintProp.name,
  label: 'X / Twitter',
  Editor: TwitterConnectedHintEditor,
})

export const blueskyConnectedEditor = definePropertyEditorOverride<boolean>({
  name: blueskyConnectedHintProp.name,
  label: 'Bluesky',
  Editor: BlueskyConnectedHintEditor,
})

export const lesswrongConnectedEditor = definePropertyEditorOverride<boolean>({
  name: lesswrongConnectedHintProp.name,
  label: 'LessWrong',
  Editor: LessWrongConnectedHintEditor,
})

export const openCredentialsDialog = async (repo: any): Promise<void> => {
  await openDialog(CredentialsDialog, {repo})
}
