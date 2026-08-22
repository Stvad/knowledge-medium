import * as React from "react"
import { type DialogProps } from "@radix-ui/react-dialog"
import { Command as CommandPrimitive, useCommandState } from "cmdk"
import { Search } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

const Command = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) => (
  <CommandPrimitive
    className={cn(
      "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
      className
    )}
    {...props}
  />
)
Command.displayName = CommandPrimitive.displayName

type CommandRootProps = React.ComponentProps<typeof Command>

interface CommandDialogProps extends DialogProps {
  title?: string
  description?: string
  contentClassName?: string
  commandProps?: Omit<CommandRootProps, "children">
}

const commandDialogClassName = "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"

const CommandDialog = ({
  children,
  title = "Command palette",
  description = "Search for a command to run.",
  contentClassName,
  commandProps,
  ...props
}: CommandDialogProps) => {
  const {className: commandClassName, ...rootCommandProps} = commandProps ?? {}

  return (
    <Dialog {...props}>
      <DialogContent className={cn("overflow-hidden p-0", contentClassName)}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command
          {...rootCommandProps}
          className={cn(commandDialogClassName, commandClassName)}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

const CommandInput = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) => (
  <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
    <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
    <CommandPrimitive.Input
      className={cn(
        "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  </div>
)

CommandInput.displayName = CommandPrimitive.Input.displayName

/**
 * Keep the active row in view, a commit later than cmdk does it.
 *
 * cmdk scrolls to whichever row the DOM currently marks `aria-selected`.
 * On a query change it re-selects the first match from inside its own
 * layout-effect queue, and the flush walks the entries it appends while
 * iterating — so the scroll runs before React has moved the mark, and
 * lands on the row that WAS selected. In a re-sorted list that row is
 * anywhere, which parks the list mid-way with the top matches scrolled
 * past. Repeating the scroll here is not redundant: this effect runs in
 * the follow-up commit, where the DOM finally names the right row. Both
 * commits land before the browser paints, so the bad position is never
 * seen.
 *
 * Keyed on the query as well as the selection: a query change that
 * happens to keep the same row selected changes no value, and would
 * otherwise leave a scrolled list scrolled.
 */
const useSelectedItemInView = (listRef: React.RefObject<HTMLDivElement | null>) => {
  const search = useCommandState(state => state.search)
  const selectedValue = useCommandState(state => state.value)

  React.useLayoutEffect(() => {
    const selected = listRef.current?.querySelector('[cmdk-item=""][aria-selected="true"]')
    if (!selected) return
    // The first row of a group sits flush under its heading — reveal the
    // heading with it, or the group reads as unlabelled.
    if (selected.parentElement?.firstChild === selected) {
      selected
        .closest('[cmdk-group=""]')
        ?.querySelector('[cmdk-group-heading=""]')
        ?.scrollIntoView({block: "nearest"})
    }
    selected.scrollIntoView({block: "nearest"})
  }, [search, selectedValue, listRef])
}

const CommandList = ({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) => {
  const listRef = React.useRef<HTMLDivElement>(null)
  useSelectedItemInView(listRef)

  return (
    <CommandPrimitive.List
      ref={node => {
        listRef.current = node
        if (typeof ref === "function") return ref(node)
        if (ref) ref.current = node
      }}
      className={cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className)}
      {...props}
    />
  )
}

CommandList.displayName = CommandPrimitive.List.displayName

const CommandEmpty = (
  props: React.ComponentProps<typeof CommandPrimitive.Empty>
) => (
  <CommandPrimitive.Empty
    className="py-6 text-center text-sm"
    {...props}
  />
)

CommandEmpty.displayName = CommandPrimitive.Empty.displayName

const CommandGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) => (
  <CommandPrimitive.Group
    className={cn(
      "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
      className
    )}
    {...props}
  />
)

CommandGroup.displayName = CommandPrimitive.Group.displayName

const CommandSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) => (
  <CommandPrimitive.Separator
    className={cn("-mx-1 h-px bg-border", className)}
    {...props}
  />
)
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

const CommandItem = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) => (
  <CommandPrimitive.Item
    className={cn(
      "relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      className
    )}
    {...props}
  />
)

CommandItem.displayName = CommandPrimitive.Item.displayName

const CommandShortcut = ({
  className,
  ...props
}: React.ComponentProps<"span">) => {
  return (
    <span
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}
CommandShortcut.displayName = "CommandShortcut"

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
