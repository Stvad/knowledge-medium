import { useState, useEffect } from 'react';
import { 
  CommandDialog, 
  CommandInput, 
  CommandList, 
  CommandEmpty, 
  CommandGroup, 
  CommandItem 
} from '@/components/ui/command';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
} from '@/components/ui/dialog';
import { OpenRouterSettings } from '@/components/settings/OpenRouterSettings';
import { refreshRendererRegistry } from '@/hooks/useRendererRegistry';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [openSettingsDialog, setOpenSettingsDialog] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const closeCommandPalette = () => {
    setOpen(false);
  };

  const openOpenRouterSettings = () => {
    setOpenSettingsDialog(true);
    closeCommandPalette();
  };
  
  const handleRefreshRendererRegistry = () => {
    refreshRendererRegistry();
    closeCommandPalette();
  };

  return (
    <>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Settings">
            <CommandItem onSelect={openOpenRouterSettings}>
              OpenRouter Settings
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Renderer">
            <CommandItem onSelect={handleRefreshRendererRegistry}>
              Refresh Renderer Registry
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      <Dialog open={openSettingsDialog} onOpenChange={setOpenSettingsDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>OpenRouter Settings</DialogTitle>
          </DialogHeader>
          <OpenRouterSettings onSave={() => setOpenSettingsDialog(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
