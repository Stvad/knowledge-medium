import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Block } from '@/data/block'
import { generateRendererBlock } from '@/services/openrouter'
import { Loader2 } from 'lucide-react'
import { rendererProp } from '@/data/properties.ts'

interface GenerateRendererDialogProps {
  block: Block;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** todo This should probably be a custom renderer for a block type of generated renderer, or just part of the
 *  standard renderer view, allowing you to ask ai for improvements
 */
export function GenerateRendererDialog({ block, open, onOpenChange }: GenerateRendererDialogProps) {
  const [rendererName, setRendererName] = useState(`custom-${Date.now()}`);
  const [includeChildren, setIncludeChildren] = useState(true);
  const [customPrompt, setCustomPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedBlockId, setGeneratedBlockId] = useState<string | null>(null);

  const handleGenerate = async () => {
    try {
      setIsGenerating(true);
      setError(null);
      
      const rendererBlock = await generateRendererBlock(block, {
        rendererName,
        includeChildren,
        customPrompt: customPrompt || undefined
      });

      block.setProperty({...rendererProp, value: rendererBlock.id});

      setGeneratedBlockId(rendererBlock.id);
      
      // Close dialog after a short delay to show success state
      setTimeout(() => {
        onOpenChange(false);
        setIsGenerating(false);
        setGeneratedBlockId(null);
        
        // Reset form for next time
        setRendererName(`custom-${Date.now()}`);
        setCustomPrompt('');
      }, 1500);
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
      setIsGenerating(false);
    }
  };

  const handleClose = () => {
    if (!isGenerating) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Generate Custom Renderer</DialogTitle>
          <DialogDescription>
            Use Claude AI to create a custom renderer for this block's content.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4" onKeyDown={() => {
          // todo: hopefully we can do better kb handling and won't need this anymore
          // if (open) e.stopPropagation()
        }}>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="rendererName" className="text-right">
              Renderer Name
            </Label>
            <Input
              id="rendererName"
              value={rendererName}
              onChange={(e) => setRendererName(e.target.value)}
              className="col-span-3"
              disabled={isGenerating}
            />
          </div>
          
          <div className="grid grid-cols-4 items-center gap-4">
            <div className="text-right">Options</div>
            <div className="flex items-center space-x-2 col-span-3">
              <Checkbox 
                id="includeChildren" 
                checked={includeChildren} 
                onCheckedChange={(checked) => setIncludeChildren(checked === true)}
                disabled={isGenerating}
              />
              <label
                htmlFor="includeChildren"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Include children blocks
              </label>
            </div>
          </div>
          
          <div className="grid grid-cols-4 items-start gap-4">
            <Label htmlFor="customPrompt" className="text-right pt-2">
              Custom Prompt
            </Label>
            <Textarea
              id="customPrompt"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              className="col-span-3 min-h-[100px]"
              placeholder="Optional: Provide specific instructions for the renderer"
              disabled={isGenerating}
            />
          </div>
          
          {error && (
            <div className="text-red-500 text-sm mt-2">
              Error: {error}
            </div>
          )}
          
          {generatedBlockId && (
            <div className="text-green-500 text-sm mt-2">
              Renderer created successfully!
            </div>
          )}
        </div>
        
        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose} disabled={isGenerating}>
            Cancel
          </Button>
          <Button type="submit" onClick={handleGenerate} disabled={isGenerating}>
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : 'Generate Renderer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
