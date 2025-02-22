import { useLocalStorage } from 'react-use'
import { BlockRendererProps } from '@/types.ts'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useState } from 'react'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { BlockComponent } from '@/components/BlockComponent.tsx'

export function LoginRenderer({block, context}: BlockRendererProps) {
  const [user, setUser] = useLocalStorage<{id: string, name: string} | undefined>('ftm.user')
  const [name, setName] = useState('')

  if (user) {
    return (
      <NestedBlockContextProvider overrides={{...context, user}}>
        <BlockComponent blockId={block.id}/>
      </NestedBlockContextProvider>
    )
  }

  const saveUser = () => {
    setUser({id: name.trim(), name: name.trim()})
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-bold text-center">Thought Medium</h1>
        <div className="space-y-2">
          <Input
            placeholder="Enter your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                saveUser()
              }
            }}
          />
          <Button 
            className="w-full" 
            onClick={() => {
              if (name.trim()) {
                saveUser()
              }
            }}
          >
            Enter
          </Button>
        </div>
      </div>
    </div>
  )
}

LoginRenderer.canRender = ({context}: BlockRendererProps) => !context?.user
LoginRenderer.priority = () => 20
