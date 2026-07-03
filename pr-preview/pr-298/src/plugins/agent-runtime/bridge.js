import { openDialog } from "../../utils/dialogs.js";
import { agentTokenStore, agentTokensChangedEvent } from "./tokens.js";
import { AgentTokensDialog } from "./AgentTokensDialog.js";
import { BridgePairingDialog } from "./BridgePairingDialog.js";
import { knownAgentCommandSchema } from "../../../packages/agent-cli/src/protocol.js";
import { createAgentRuntimeContext, executeCommand } from "./commands.js";
import { serializeError, serializeValue } from "./serialization.js";
//#region src/plugins/agent-runtime/bridge.ts
var defaultBridgeUrl = "http://127.0.0.1:8787";
var bridgeUrlStorageKey = "agent-runtime:bridge-url";
var bridgeSecretStorageKey = "agent-runtime:bridge-secret";
var longPollMs = 25e3;
var retryBaseMs = 1e3;
var retryMaxMs = 3e4;
var maxFastAttemptsBeforeQuiet = 6;
var quietRetryMs = 6e4;
var agentRuntimeBridgeRestartEvent = "agent-runtime-bridge:restart";
var bridgeClientId = null;
var getBridgeClientId = () => {
	bridgeClientId ??= crypto.randomUUID();
	return bridgeClientId;
};
var loopbackHostnames = new Set([
	"127.0.0.1",
	"localhost",
	"::1",
	"[::1]"
]);
var isLoopbackBridgeUrl = (value) => {
	try {
		const { protocol, hostname } = new URL(value);
		return (protocol === "http:" || protocol === "https:") && loopbackHostnames.has(hostname);
	} catch {
		return false;
	}
};
var persistPairing = (url, secret) => {
	window.localStorage.setItem(bridgeUrlStorageKey, url);
	if (secret) window.localStorage.setItem(bridgeSecretStorageKey, secret);
	window.dispatchEvent(new CustomEvent(agentRuntimeBridgeRestartEvent));
};
var confirmAndStorePairing = async (url, secret, openTokensDialog) => {
	if (!await openDialog(BridgePairingDialog, {
		url,
		hasSecret: Boolean(secret)
	})) return;
	persistPairing(url, secret);
	if (openTokensDialog) openDialog(AgentTokensDialog, { mode: "pair-cli" });
};
var processBridgePairingFromHash = () => {
	const rawHash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
	if (!rawHash) return;
	const queryIndex = rawHash.indexOf("?");
	const paramSource = queryIndex >= 0 ? rawHash.slice(queryIndex + 1) : rawHash;
	const params = new URLSearchParams(paramSource);
	const secret = params.get("agent-runtime-secret")?.trim() || null;
	const rawUrl = params.get("agent-runtime-url")?.trim() || null;
	const openTokensDialog = params.get("agent-runtime-open-tokens") === "1";
	if (!secret && !rawUrl && !openTokensDialog) return;
	params.delete("agent-runtime-secret");
	params.delete("agent-runtime-url");
	params.delete("agent-runtime-open-tokens");
	const remainingParams = params.toString();
	const routeHash = queryIndex >= 0 ? rawHash.slice(0, queryIndex) : "";
	const nextHash = routeHash || remainingParams ? `#${routeHash}${remainingParams ? `?${remainingParams}` : ""}` : "";
	window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}${nextHash}`);
	const candidateUrl = rawUrl ? rawUrl.replace(/\/+$/, "") : null;
	if (candidateUrl && !isLoopbackBridgeUrl(candidateUrl)) {
		console.warn("Agent runtime: ignoring pairing link with a non-loopback bridge URL.");
		return;
	}
	if (candidateUrl) {
		window.setTimeout(() => {
			confirmAndStorePairing(candidateUrl, secret, openTokensDialog);
		}, 0);
		return;
	}
	if (secret) console.warn("Agent runtime: ignoring pairing secret supplied without a bridge URL.");
	if (openTokensDialog) window.setTimeout(() => {
		openDialog(AgentTokensDialog, { mode: "pair-cli" });
	}, 0);
};
var readTrustedStoredBridgeUrl = () => {
	const stored = window.localStorage.getItem(bridgeUrlStorageKey)?.trim();
	if (!stored) return null;
	if (isLoopbackBridgeUrl(stored)) return stored;
	window.localStorage.removeItem(bridgeUrlStorageKey);
	window.localStorage.removeItem(bridgeSecretStorageKey);
	console.warn("Agent runtime: purged a stored non-loopback bridge URL.");
	return null;
};
var getStoredBridgeSecret = () => window.localStorage.getItem(bridgeSecretStorageKey)?.trim() || (void 0)?.trim() || "";
var bridgeUrl = () => (readTrustedStoredBridgeUrl() || (void 0)?.trim() || defaultBridgeUrl).replace(/\/+$/, "");
var bridgeHeaders = () => {
	const secret = getStoredBridgeSecret();
	if (!secret) throw new Error("Agent runtime bridge is not paired. Start the bridge server and open its pairing URL.");
	return { "x-agent-runtime-secret": secret };
};
var postJson = async (url, body, signal, clientId) => {
	const response = await window.fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...bridgeHeaders(),
			...clientId ? { "x-agent-runtime-client-id": clientId } : {}
		},
		body: JSON.stringify(body),
		signal
	});
	if (!response.ok) throw new Error(`Agent runtime bridge request failed: ${response.status}`);
	return response;
};
var startAgentRuntimeBridge = (options) => {
	const abortController = new AbortController();
	const clientId = getBridgeClientId();
	processBridgePairingFromHash();
	let retryMs = retryBaseMs;
	let attempts = 0;
	let wakeResolve = null;
	let bridgeUnavailableLogged = false;
	let tokensDirty = false;
	const waitForWakeOrTimeout = (ms) => new Promise((resolve) => {
		let settled = false;
		let timeout = null;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (timeout !== null) window.clearTimeout(timeout);
			if (wakeResolve === finish) wakeResolve = null;
			resolve();
		};
		timeout = window.setTimeout(finish, ms);
		wakeResolve = finish;
	});
	const wakeBridgeLoop = (markTokensDirty = false) => {
		attempts = 0;
		retryMs = retryBaseMs;
		if (markTokensDirty) tokensDirty = true;
		if (wakeResolve) {
			wakeResolve();
			wakeResolve = null;
		}
	};
	const register = (baseUrl = bridgeUrl()) => {
		const { repo, safeMode } = options;
		const userId = repo.user.id;
		const workspaceId = repo.activeWorkspaceId;
		const tokens = userId && workspaceId ? agentTokenStore.list(userId, workspaceId).map((t) => ({
			token: t.token,
			label: t.label,
			scope: t.scope ?? "read-write",
			userId,
			workspaceId
		})) : [];
		tokensDirty = false;
		return postJson(`${baseUrl}/runtime/clients/${clientId}`, {
			activeWorkspaceId: workspaceId,
			currentUser: repo.user,
			safeMode,
			href: window.location.href,
			userAgent: window.navigator.userAgent,
			audience: {
				userId,
				workspaceId
			},
			tokens
		}, abortController.signal);
	};
	const reportResult = async (commandId, payload, baseUrl = bridgeUrl()) => {
		await postJson(`${baseUrl}/runtime/commands/${commandId}/result`, payload, abortController.signal, clientId);
	};
	const handleRestart = () => {
		wakeBridgeLoop(true);
	};
	const handleTokensChanged = () => {
		tokensDirty = true;
		wakeBridgeLoop();
		register().catch(() => {});
	};
	const handleVisibilityChanged = () => {
		if (document.visibilityState === "visible") wakeBridgeLoop();
	};
	const handleWakeEvent = () => {
		wakeBridgeLoop();
	};
	const handleHashChanged = () => {
		processBridgePairingFromHash();
		wakeBridgeLoop(true);
	};
	window.addEventListener(agentRuntimeBridgeRestartEvent, handleRestart);
	window.addEventListener(agentTokensChangedEvent, handleTokensChanged);
	window.addEventListener("focus", handleWakeEvent);
	window.addEventListener("hashchange", handleHashChanged);
	window.addEventListener("online", handleWakeEvent);
	document.addEventListener("visibilitychange", handleVisibilityChanged);
	const poll = async () => {
		while (!abortController.signal.aborted) {
			const baseUrl = bridgeUrl();
			try {
				if (tokensDirty) tokensDirty = false;
				await register(baseUrl);
				if (bridgeUnavailableLogged) {
					console.info(`Agent runtime bridge reconnected at ${baseUrl}.`);
					bridgeUnavailableLogged = false;
				}
				const nextUrl = new URL(`${baseUrl}/runtime/commands/next`);
				nextUrl.searchParams.set("clientId", clientId);
				nextUrl.searchParams.set("timeoutMs", String(longPollMs));
				const response = await window.fetch(nextUrl, {
					headers: bridgeHeaders(),
					signal: abortController.signal
				});
				if (!response.ok) throw new Error(`Agent runtime bridge poll failed: ${response.status}`);
				const rawCommand = await response.json();
				retryMs = retryBaseMs;
				attempts = 0;
				if (!rawCommand) continue;
				const parsed = knownAgentCommandSchema.safeParse(rawCommand);
				const commandIdForResult = rawCommand?.commandId;
				if (!parsed.success) {
					if (commandIdForResult) await reportResult(commandIdForResult, {
						ok: false,
						error: serializeError(/* @__PURE__ */ new Error(`Invalid command body: ${parsed.error.issues.map((i) => i.message).join("; ")}`))
					}, baseUrl);
					continue;
				}
				const command = parsed.data;
				try {
					const value = await executeCommand(command, createAgentRuntimeContext(options));
					await reportResult(command.commandId, {
						ok: true,
						value: serializeValue(value)
					}, baseUrl);
				} catch (error) {
					await reportResult(command.commandId, {
						ok: false,
						error: serializeError(error)
					}, baseUrl);
				}
			} catch {
				if (abortController.signal.aborted) return;
				attempts += 1;
				if (attempts >= maxFastAttemptsBeforeQuiet) {
					if (!bridgeUnavailableLogged) {
						console.info(`Agent runtime bridge unavailable at ${baseUrl}; retrying quietly every ${quietRetryMs / 1e3} seconds.`);
						bridgeUnavailableLogged = true;
					}
					await waitForWakeOrTimeout(quietRetryMs);
					if (abortController.signal.aborted) return;
					continue;
				}
				await waitForWakeOrTimeout(retryMs);
				if (abortController.signal.aborted) return;
				retryMs = Math.min(retryMs * 2, retryMaxMs);
			}
		}
	};
	poll();
	return () => {
		abortController.abort();
		window.removeEventListener(agentRuntimeBridgeRestartEvent, handleRestart);
		window.removeEventListener(agentTokensChangedEvent, handleTokensChanged);
		window.removeEventListener("focus", handleWakeEvent);
		window.removeEventListener("hashchange", handleHashChanged);
		window.removeEventListener("online", handleWakeEvent);
		document.removeEventListener("visibilitychange", handleVisibilityChanged);
		if (wakeResolve) {
			wakeResolve();
			wakeResolve = null;
		}
	};
};
//#endregion
export { agentRuntimeBridgeRestartEvent, bridgeUrl, isLoopbackBridgeUrl, processBridgePairingFromHash, startAgentRuntimeBridge };

//# sourceMappingURL=bridge.js.map