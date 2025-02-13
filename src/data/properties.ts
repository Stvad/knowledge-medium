import { useUIStateProperty } from '@/data/globalState.ts'

export const useIsEditing = () => {
  return useUIStateProperty<boolean>('isEditing', false)
}
