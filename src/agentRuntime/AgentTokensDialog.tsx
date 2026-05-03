import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useRepo } from '@/context/repo.tsx'
import {
  AgentToken,
  agentTokenStore,
  notifyAgentTokensChanged,
} from '@/agentRuntime/agentTokens.ts'

export const openAgentTokensDialogEvent = 'agent-runtime-bridge:open-tokens-dialog'

interface AgentTokensDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AgentTokensDialog({open, onOpenChange}: AgentTokensDialogProps) {
  const repo = useRepo()
  const userId = repo.user.id
  const workspaceId = repo.activeWorkspaceId

  const [tokens, setTokens] = useState<AgentToken[]>([])
  const [label, setLabel] = useState('')
  const [justMinted, setJustMinted] = useState<AgentToken | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle')

  const refresh = () => {
    if (!userId || !workspaceId) {
      setTokens([])
      return
    }
    setTokens(agentTokenStore.list(userId, workspaceId))
  }

  useEffect(() => {
    if (open) {
      refresh()
      setJustMinted(null)
      setCopyState('idle')
      setLabel('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId, workspaceId])

  const mint = () => {
    if (!userId || !workspaceId) return
    const token = agentTokenStore.create(userId, workspaceId, label)
    notifyAgentTokensChanged()
    setJustMinted(token)
    setCopyState('idle')
    setLabel('')
    refresh()
  }

  const revoke = (token: string) => {
    if (!userId || !workspaceId) return
    agentTokenStore.revoke(userId, workspaceId, token)
    notifyAgentTokensChanged()
    if (justMinted?.token === token) setJustMinted(null)
    refresh()
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1500)
    } catch (error) {
      console.error('Clipboard write failed', error)
    }
  }

  const noWorkspace = !userId || !workspaceId

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent runtime tokens</DialogTitle>
          <DialogDescription>
            Tokens authorize a local agent process to drive this workspace as you.
            Stored on this device only — not synced. Each token is shown once at mint.
          </DialogDescription>
        </DialogHeader>

        {noWorkspace ? (
          <p className="text-sm text-destructive">
            Open a workspace before minting agent tokens.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="agent-token-label">New token label</Label>
              <div className="flex gap-2">
                <Input
                  id="agent-token-label"
                  placeholder="e.g. claude-cli"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') mint() }}
                />
                <Button type="button" onClick={mint}>
                  Generate
                </Button>
              </div>
            </div>

            {justMinted && (
              <div className="rounded-md border bg-muted/40 p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Copy now — this is the only time the secret is shown.
                </p>
                <div className="flex gap-2 items-center">
                  <code className="flex-1 truncate text-xs font-mono">{justMinted.token}</code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => copy(justMinted.token)}
                  >
                    {copyState === 'copied' ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Run <code>yarn agent connect {justMinted.token}</code> to register it with the CLI.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>Existing tokens</Label>
              {tokens.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tokens yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {tokens.map((t) => (
                    <li
                      key={t.token}
                      className="flex items-center justify-between rounded border p-2 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="font-medium truncate">{t.label}</div>
                        <div className="text-xs text-muted-foreground">
                          created {new Date(t.createdAt).toLocaleString()}
                          {t.lastSeenAt
                            ? ` · last seen ${new Date(t.lastSeenAt).toLocaleString()}`
                            : ''}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => revoke(t.token)}
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function AgentTokensDialogMount() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener(openAgentTokensDialogEvent, handler)
    return () => window.removeEventListener(openAgentTokensDialogEvent, handler)
  }, [])

  return <AgentTokensDialog open={open} onOpenChange={setOpen}/>
}
