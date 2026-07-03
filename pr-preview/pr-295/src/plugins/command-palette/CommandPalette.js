import groupBy from "../../../node_modules/lodash-es/groupBy.js";
import { editorViewFromActiveContexts, useActiveContextsState } from "../../shortcuts/ActiveContexts.js";
import { useActionContext } from "../../shortcuts/useActionContext.js";
import { acquireEditModeKeepalive } from "../../components/editModeKeepalive.js";
import { actionRuntimeKey } from "../../shortcuts/effectiveActions.js";
import { useRunAction } from "../../shortcuts/runAction.js";
import { Kbd } from "../../components/ui/kbd.js";
import { commandPaletteToggle } from "./toggleStore.js";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../components/ui/command.js";
import { formatChord } from "../keybindings-settings/keyCapture.js";
import { COMMAND_PALETTE_CONTEXT } from "./context.js";
import { useCommandPaletteActions } from "./useCommandPaletteActions.js";
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/command-palette/CommandPalette.tsx
var formatShortcutKeys = (bindings) => {
	if (!bindings || bindings.length === 0) return [];
	return bindings.flatMap((binding) => Array.isArray(binding.keys) ? binding.keys : [binding.keys]);
};
function CommandPalette() {
	const open = useSyncExternalStore(commandPaletteToggle.subscribe, commandPaletteToggle.isOpen, commandPaletteToggle.isOpen);
	useActionContext(COMMAND_PALETTE_CONTEXT, useMemo(() => ({}), []), open);
	const active = useActiveContextsState();
	const activeRef = useRef(active);
	useLayoutEffect(() => {
		activeRef.current = active;
	}, [active]);
	useLayoutEffect(() => {
		if (!open) return;
		const editorView = editorViewFromActiveContexts(activeRef.current);
		if (!editorView) return;
		const release = acquireEditModeKeepalive("yield-focus");
		return () => {
			if (editorViewFromActiveContexts(activeRef.current) === editorView && editorView.dom.isConnected) editorView.focus();
			release();
		};
	}, [open]);
	const { actions, activeContexts, bindingsFor } = useCommandPaletteActions();
	const runAction = useRunAction();
	const { activeContextsInfo, groupedActions } = useMemo(() => {
		if (!open) return {
			activeContextsInfo: [],
			groupedActions: {}
		};
		return {
			activeContextsInfo: [...activeContexts].reverse(),
			groupedActions: groupBy(actions, "context")
		};
	}, [
		open,
		actions,
		activeContexts
	]);
	const runCommand = (actionId) => {
		const logFailure = (error) => console.error(`[CommandPalette] Failed to execute action: ${actionId}`, error);
		try {
			Promise.resolve(runAction(actionId, new CustomEvent("command-pallet-trigger"))).catch(logFailure);
		} catch (error_0) {
			logFailure(error_0);
		} finally {
			commandPaletteToggle.close();
		}
	};
	return /* @__PURE__ */ jsxs(CommandDialog, {
		open,
		onOpenChange: commandPaletteToggle.set,
		contentClassName: "top-[12vh] translate-y-0",
		children: [/* @__PURE__ */ jsx(CommandInput, { placeholder: "Type a command or search..." }), /* @__PURE__ */ jsxs(CommandList, { children: [/* @__PURE__ */ jsx(CommandEmpty, { children: "No results found." }), activeContextsInfo.map(({ config }) => {
			const contextType = config.type;
			const actionsInGroup = groupedActions[contextType];
			if (!actionsInGroup || actionsInGroup.length === 0) return null;
			const groupHeading = config.displayName || contextType;
			return /* @__PURE__ */ jsx(CommandGroup, {
				heading: groupHeading,
				children: actionsInGroup.map((action) => {
					const shortcutKeys = formatShortcutKeys(bindingsFor(action));
					const itemKey = actionRuntimeKey(action);
					return /* @__PURE__ */ jsxs(CommandItem, {
						value: itemKey,
						keywords: [groupHeading, action.description],
						onSelect: () => runCommand(action.id),
						className: "flex justify-between items-center",
						children: [/* @__PURE__ */ jsx("span", { children: action.description }), shortcutKeys.length > 0 && /* @__PURE__ */ jsx("div", {
							className: "flex gap-1",
							children: shortcutKeys.map((keyStr, index) => /* @__PURE__ */ jsx(Kbd, { children: formatChord(keyStr) }, index))
						})]
					}, itemKey);
				})
			}, contextType);
		})] })]
	});
}
//#endregion
export { CommandPalette };

//# sourceMappingURL=CommandPalette.js.map