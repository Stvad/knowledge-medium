import { AutomergeUrl } from '@automerge/automerge-repo'
import { Block } from '../types'
import { getAllChildrenBlocks } from '../utils/block-operations'
import { importState } from '../utils/state'
import { useRepo } from '@automerge/automerge-repo-react-hooks'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { ThemeToggle } from './ui/theme-toggle'

interface DocumentControlsProps {
    docUrl: AutomergeUrl
}

export function DocumentStateManagement({ docUrl}: DocumentControlsProps) {
    const repo = useRepo()
    const exportState = async () => {
        const blocks = await getAllChildrenBlocks(repo, docUrl)
        const exportData = { blocks }
        const jsonString = JSON.stringify(exportData, null, 2)
        
        const downloadLink = document.createElement('a')
        downloadLink.download = 'document-state.json'
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
                const state = JSON.parse(content) as { blocks: Block[] }
                if (!Array.isArray(state.blocks)) {
                    throw new Error('Invalid document structure')
                }
                
                const blockDocsMap = await importState(state, repo)
                const firstBlock = blockDocsMap.get(state.blocks[0].id)
                if (firstBlock) {
                    window.location.href = `/#${firstBlock.url}`
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
            <ThemeToggle />
        </div>
    )
} 
