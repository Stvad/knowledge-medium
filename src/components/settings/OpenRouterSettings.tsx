import { useState, useEffect } from 'react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { saveOpenRouterConfig, getOpenRouterConfig } from '@/services/openrouter'
import { useRepo } from '@/context/repo'
import { useBlockContext } from '@/context/block'
import { useUser } from '@/components/Login'

interface OpenRouterSettingsProps {
  onSave?: () => void;
}

/**
 *  Todo: This should be a custom renderer on that block, generally this can serve as a template for general config block type?
 *  It's still nice to have a comment to open this in popup/sidebar/etc though
 */
export function OpenRouterSettings({onSave}: OpenRouterSettingsProps) {
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('anthropic/claude-3.7-sonnet:beta')
  const [baseUrl, setBaseUrl] = useState('https://openrouter.ai/api/v1')
  const [loading, setLoading] = useState(true)

  const repo = useRepo()
  const {rootBlockId} = useBlockContext()
  const user = useUser()

  // Load saved settings on initial render
  useEffect(() => {
    const loadConfig = async () => {
      try {
        if (!rootBlockId || !user) return

        const config = await getOpenRouterConfig(repo.find(rootBlockId), user)

        setApiKey(config.apiKey)
        setModel(config.model)
        setBaseUrl(config.baseUrl)
      } catch (error) {
        console.error('Failed to load OpenRouter config:', error)
      } finally {
        setLoading(false)
      }
    }

    loadConfig()
  }, [repo, rootBlockId, user])

  const handleSave = async () => {
    if (!rootBlockId || !user) return

    try {
      // Save other config to UI state
      await saveOpenRouterConfig(repo.find(rootBlockId), user, {
        model,
        baseUrl,
        apiKey,
      })

      // Call onSave if provided
      if (onSave) onSave()
    } catch (error) {
      console.error('Failed to save OpenRouter config:', error)
    }
  }

  if (loading) {
    return <div>Loading settings...</div>
  }

  return (
    <div className="space-y-4 p-4">
      {/*<h3 className="text-lg font-medium">OpenRouter API Settings</h3>*/}
      <p className="text-sm text-muted-foreground">
        Configure your OpenRouter API settings to enable AI-generated renderers.
        You'll need an API key from <a href="https://openrouter.ai" target="_blank" rel="noreferrer"
                                       className="text-blue-500 hover:underline">OpenRouter</a>.
      </p>

      <div className="space-y-2">
        <Label htmlFor="apiKey">API Key</Label>
        <Input
          id="apiKey"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="your-openrouter-api-key"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="model">Model</Label>
        <Input
          id="model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="anthropic/claude-3.7-sonnet:beta"
        />
        <p className="text-xs text-muted-foreground">
          Recommended models: anthropic/claude-3-haiku, anthropic/claude-3-sonnet
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="baseUrl">API Endpoint</Label>
        <Input
          id="baseUrl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://openrouter.ai/api/v1"
        />
      </div>

      <Button onClick={handleSave}>Save Settings</Button>
    </div>
  )
}
