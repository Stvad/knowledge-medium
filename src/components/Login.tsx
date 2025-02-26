import { createContext, useContext, useState, ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useLocalStorage } from 'react-use'
import { User } from '@/types.ts'

interface UserContextType {
  user: User
  setUser: (user?: User) => void
}

const UserContext = createContext<UserContextType | undefined>(undefined)

export const useUser = () => {
  const context = useContext(UserContext)
  if (!context) throw new Error('useUser must be used within a Login component')
  return context.user
}

export function Login({children}: { children: ReactNode }) {
  const [user, setUser] = useLocalStorage<User | undefined>('ftm.user', undefined)
  const [name, setName] = useState('')

  if (user) {
    return (
      <UserContext value={{user, setUser}}>
        {children}
      </UserContext>
    )
  }

  const userName = name.trim()

  const updateUser = () => {
    if (userName) {
      setUser({id: userName, name: userName})
    }
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
              if (e.key === 'Enter') updateUser()
            }}
          />
          <Button
            className="w-full"
            onClick={() => updateUser()}
          >
            Enter
          </Button>
        </div>
      </div>
    </div>
  )
}
