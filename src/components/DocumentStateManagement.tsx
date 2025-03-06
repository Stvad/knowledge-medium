import { AutomergeUrl } from '@automerge/automerge-repo'
import { BlockData } from '../types'
import { importState } from '../utils/state'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { ThemeToggle } from './ui/theme-toggle'
import { getAllChildrenBlocks } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useUser } from '@/components/Login'

interface DocumentControlsProps {
    docUrl: AutomergeUrl
}

export function DocumentStateManagement({ docUrl}: DocumentControlsProps) {
    const repo = useRepo()
    const user = useUser()
    
    const exportState = async () => {
        const blocks = await getAllChildrenBlocks(repo, docUrl)
        const exportData = { blocks }
        const jsonString = JSON.stringify(exportData, null, 2)
        
        const downloadLink = document.createElement('a')
        downloadLink.download = `document-state-${new Date().toUTCString()}.json`
        downloadLink.href = `data:application/json;charset=utf-8,${encodeURIComponent(jsonString)}`
        downloadLink.click()
    }

    const importFromFile = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file) return

        const reader = new FileReader()
        reader.onload = async(e) => {
            const content = e.target?.result as string
            try {
                const state = JSON.parse(content) as { blocks: BlockData[] }
                if (!Array.isArray(state.blocks)) {
                    throw new Error('Invalid document structure')
                }
                
                const blockDocsMap = await importState(state, repo)
                const firstBlock = blockDocsMap.get(state.blocks[0].id)
                if (firstBlock) {
                    window.location.href = `/#${firstBlock.id}`
                }
            } catch (err) {
                console.error('Failed to import document:', err)
                alert('Invalid document format')
            }
        }
        reader.readAsText(file)
    }

    return (
        <div className="flex items-center justify-between p-4 border-b border-border">
            <div className="flex items-center gap-4">
                <Button 
                    variant="outline"
                    onClick={exportState}
                >
                    Export Document
                </Button>
            
                <div className="flex items-center gap-2">
                    <Label htmlFor="import-file">Import Document</Label>
                    <Input
                        id="import-file"
                        type="file"
                        accept=".json"
                        onChange={importFromFile}
                        className="w-auto"
                    />
                </div>
            </div>
            <div className="flex items-center gap-4">
                <button 
                    className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => {
                        // Simulate Cmd+K or Ctrl+K keypress
                        const event = new KeyboardEvent('keydown', {
                            key: 'k',
                            metaKey: true,
                            ctrlKey: navigator.platform.toLowerCase().includes('win'),
                            bubbles: true
                        });
                        document.dispatchEvent(event);
                    }}
                >
                    <span>Command</span>
                    <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                        {navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+'}K
                    </kbd>
                </button>
                <ThemeToggle />
                {user && <span className="text-sm text-muted-foreground">{user.name}</span>}
            </div>
        </div>
    )
}
