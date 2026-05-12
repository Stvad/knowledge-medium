const OPENAI_API_KEY_STORAGE_KEY = 'knowledge-medium:openai-api-key:v1'

const browserStorage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export const readStoredOpenAiApiKey = (): string | null => {
  const value = browserStorage()?.getItem(OPENAI_API_KEY_STORAGE_KEY)?.trim()
  return value ? value : null
}

export const hasStoredOpenAiApiKey = (): boolean =>
  readStoredOpenAiApiKey() !== null

export const saveOpenAiApiKey = (apiKey: string): void => {
  const trimmed = apiKey.trim()
  if (!trimmed) throw new Error('OpenAI API key is required')
  const storage = browserStorage()
  if (!storage) throw new Error('Browser local storage is unavailable')
  storage.setItem(OPENAI_API_KEY_STORAGE_KEY, trimmed)
}

export const clearOpenAiApiKey = (): void => {
  browserStorage()?.removeItem(OPENAI_API_KEY_STORAGE_KEY)
}
