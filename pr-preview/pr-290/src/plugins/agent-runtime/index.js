import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, appEffectsFacet } from "../../extensions/core.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { openDialog } from "../../utils/dialogs.js";
import { dialogAppMountExtension } from "../../extensions/dialogAppMount.js";
import { AgentTokensDialog } from "./AgentTokensDialog.js";
import { agentRuntimeBridgeRestartEvent, startAgentRuntimeBridge } from "./bridge.js";
//#region src/plugins/agent-runtime/index.ts
var agentRuntimeBridgeEffect = {
	id: "agent-runtime.bridge",
	start: startAgentRuntimeBridge
};
var restartAgentRuntimeBridgeAction = {
	id: "restart_agent_runtime_bridge",
	description: "Restart agent runtime bridge",
	context: ActionContextTypes.GLOBAL,
	handler: () => {
		window.dispatchEvent(new CustomEvent(agentRuntimeBridgeRestartEvent));
	}
};
var manageAgentTokensAction = {
	id: "manage_agent_tokens",
	description: "Manage agent runtime tokens",
	context: ActionContextTypes.GLOBAL,
	handler: () => {
		openDialog(AgentTokensDialog);
	}
};
var agentRuntimePlugin = systemToggle({
	id: "system:agent-runtime",
	name: "Agent runtime",
	description: "Bridge that lets external agents drive the app through a typed command protocol (also exposes per-token management UI)."
}).of([
	dialogAppMountExtension,
	appEffectsFacet.of(agentRuntimeBridgeEffect, { source: "agent-runtime" }),
	actionsFacet.of(restartAgentRuntimeBridgeAction, { source: "agent-runtime" }),
	actionsFacet.of(manageAgentTokensAction, { source: "agent-runtime" })
]);
//#endregion
export { agentRuntimeBridgeEffect, agentRuntimeBridgeRestartEvent, agentRuntimePlugin, manageAgentTokensAction, restartAgentRuntimeBridgeAction };

//# sourceMappingURL=index.js.map