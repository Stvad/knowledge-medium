import { appMountsFacet } from "./core.js";
import { useRepo } from "../context/repo.js";
import { AppRuntimeContextProvider } from "./runtimeContext.js";
import { ActiveContextsProvider } from "../shortcuts/ActiveContexts.js";
import { ExtensionRenderBoundary } from "./ExtensionRenderBoundary.js";
import { ExtensionLoadErrorStore, ExtensionLoadErrorsProvider } from "./extensionLoadErrors.js";
import { dynamicExtensionsExtension } from "./dynamicExtensions.js";
import { resolveAppRuntime, resolveAppRuntimeSync } from "../facets/resolveAppRuntime.js";
import { useOverrides } from "./useOverrides.js";
import { EffectReconciler } from "./liveRuntime.js";
import { HotkeyReconciler } from "../shortcuts/HotkeyReconciler.js";
import { ExtensionApprovalStatusProvider, ExtensionApprovalStatusStore } from "./extensionApprovalStatus.js";
import { staticAppExtensions } from "./staticAppExtensions.js";
import { toastExtensionLoadError } from "./extensionLoadErrorToast.js";
import { useEffect, useRef, useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/extensions/AppRuntimeProvider.tsx
function AppRuntimeProvider(t0) {
	const $ = c(53);
	const { children, safeMode } = t0;
	const repo = useRepo();
	const workspaceId = repo.activeWorkspaceId;
	const { overrides, generation } = useOverrides(workspaceId);
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = new ExtensionLoadErrorStore();
		$[0] = t1;
	} else t1 = $[0];
	const errorStore = t1;
	let t2;
	if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ new Set();
		$[1] = t2;
	} else t2 = $[1];
	const toastedLoadErrors = useRef(t2);
	let t3;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = new ExtensionApprovalStatusStore();
		$[2] = t3;
	} else t3 = $[2];
	const approvalStore = t3;
	let t4;
	if ($[3] !== generation || $[4] !== repo || $[5] !== safeMode || $[6] !== workspaceId) {
		t4 = {
			repo,
			workspaceId,
			safeMode,
			generation
		};
		$[3] = generation;
		$[4] = repo;
		$[5] = safeMode;
		$[6] = workspaceId;
		$[7] = t4;
	} else t4 = $[7];
	const runtimeContext = t4;
	let t5;
	if ($[8] !== repo) {
		t5 = staticAppExtensions({ repo });
		$[8] = repo;
		$[9] = t5;
	} else t5 = $[9];
	const baseExtensions = t5;
	let t6;
	if ($[10] !== baseExtensions || $[11] !== overrides || $[12] !== runtimeContext || $[13] !== safeMode) {
		t6 = resolveAppRuntimeSync(baseExtensions, {
			overrides,
			safeMode,
			context: runtimeContext
		});
		$[10] = baseExtensions;
		$[11] = overrides;
		$[12] = runtimeContext;
		$[13] = safeMode;
		$[14] = t6;
	} else t6 = $[14];
	const baseRuntime = t6;
	const [runtime, setRuntime] = useState(baseRuntime);
	let t7;
	if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
		t7 = new EffectReconciler();
		$[15] = t7;
	} else t7 = $[15];
	const effectReconciler = t7;
	let t8;
	let t9;
	if ($[16] !== baseRuntime || $[17] !== repo || $[18] !== safeMode || $[19] !== workspaceId) {
		t8 = () => {
			if (!effectReconciler.isColdFor(repo, workspaceId, safeMode)) return;
			setRuntime(baseRuntime);
			repo.setFacetRuntime(baseRuntime);
		};
		t9 = [
			baseRuntime,
			effectReconciler,
			repo,
			workspaceId,
			safeMode
		];
		$[16] = baseRuntime;
		$[17] = repo;
		$[18] = safeMode;
		$[19] = workspaceId;
		$[20] = t8;
		$[21] = t9;
	} else {
		t8 = $[20];
		t9 = $[21];
	}
	useEffect(t8, t9);
	let t10;
	let t11;
	if ($[22] !== baseExtensions || $[23] !== overrides || $[24] !== repo || $[25] !== runtimeContext || $[26] !== safeMode || $[27] !== workspaceId) {
		t10 = () => {
			let cancelled = false;
			errorStore.reset();
			approvalStore.reset();
			if (!workspaceId) return;
			(async () => {
				try {
					const nextRuntime = await resolveAppRuntime([baseExtensions, dynamicExtensionsExtension({
						repo,
						workspaceId,
						safeMode,
						overrides,
						errorReporter: (blockId, error_0) => {
							if (cancelled) return;
							errorStore.reportError(blockId, error_0);
							toastExtensionLoadError(toastedLoadErrors.current, `${workspaceId}:${blockId}`, blockId, error_0);
						},
						approvalStatusReporter: (blockId_0, status) => {
							if (cancelled) return;
							approvalStore.report(blockId_0, status);
						}
					})], {
						overrides,
						safeMode,
						context: runtimeContext
					});
					if (!cancelled) {
						setRuntime(nextRuntime);
						repo.setFacetRuntime(nextRuntime);
					}
				} catch (t12) {
					console.error("Failed to resolve app runtime", t12);
				}
			})();
			return () => {
				cancelled = true;
			};
		};
		t11 = [
			approvalStore,
			baseExtensions,
			errorStore,
			overrides,
			repo,
			runtimeContext,
			safeMode,
			workspaceId
		];
		$[22] = baseExtensions;
		$[23] = overrides;
		$[24] = repo;
		$[25] = runtimeContext;
		$[26] = safeMode;
		$[27] = workspaceId;
		$[28] = t10;
		$[29] = t11;
	} else {
		t10 = $[28];
		t11 = $[29];
	}
	useEffect(t10, t11);
	let t12;
	let t13;
	if ($[30] !== repo || $[31] !== runtime || $[32] !== safeMode || $[33] !== workspaceId) {
		t12 = () => {
			if (!workspaceId) {
				effectReconciler.dispose();
				return;
			}
			effectReconciler.reconcile(repo, runtime, workspaceId, safeMode);
		};
		t13 = [
			effectReconciler,
			repo,
			runtime,
			safeMode,
			workspaceId
		];
		$[30] = repo;
		$[31] = runtime;
		$[32] = safeMode;
		$[33] = workspaceId;
		$[34] = t12;
		$[35] = t13;
	} else {
		t12 = $[34];
		t13 = $[35];
	}
	useEffect(t12, t13);
	let t14;
	let t15;
	if ($[36] === Symbol.for("react.memo_cache_sentinel")) {
		t14 = () => () => effectReconciler.dispose();
		t15 = [effectReconciler];
		$[36] = t14;
		$[37] = t15;
	} else {
		t14 = $[36];
		t15 = $[37];
	}
	useEffect(t14, t15);
	let t16;
	if ($[38] !== repo.projectors || $[39] !== workspaceId) {
		t16 = () => {
			if (!workspaceId) return;
			const dispose = repo.projectors.startAll();
			return () => dispose();
		};
		$[38] = repo.projectors;
		$[39] = workspaceId;
		$[40] = t16;
	} else t16 = $[40];
	let t17;
	if ($[41] !== repo || $[42] !== workspaceId) {
		t17 = [repo, workspaceId];
		$[41] = repo;
		$[42] = workspaceId;
		$[43] = t17;
	} else t17 = $[43];
	useEffect(t16, t17);
	let t18;
	if ($[44] === Symbol.for("react.memo_cache_sentinel")) {
		t18 = /* @__PURE__ */ jsx(HotkeyReconciler, {});
		$[44] = t18;
	} else t18 = $[44];
	let t19;
	if ($[45] !== runtime) {
		t19 = /* @__PURE__ */ jsx(AppMounts, { runtime });
		$[45] = runtime;
		$[46] = t19;
	} else t19 = $[46];
	let t20;
	if ($[47] !== children || $[48] !== t19) {
		t20 = /* @__PURE__ */ jsx(ExtensionLoadErrorsProvider, {
			store: errorStore,
			children: /* @__PURE__ */ jsx(ExtensionApprovalStatusProvider, {
				store: approvalStore,
				children: /* @__PURE__ */ jsxs(ActiveContextsProvider, { children: [
					t18,
					t19,
					children
				] })
			})
		});
		$[47] = children;
		$[48] = t19;
		$[49] = t20;
	} else t20 = $[49];
	let t21;
	if ($[50] !== runtime || $[51] !== t20) {
		t21 = /* @__PURE__ */ jsx(AppRuntimeContextProvider, {
			value: runtime,
			children: t20
		});
		$[50] = runtime;
		$[51] = t20;
		$[52] = t21;
	} else t21 = $[52];
	return t21;
}
function AppMounts(t0) {
	const $ = c(6);
	const { runtime } = t0;
	let t1;
	if ($[0] !== runtime) {
		t1 = runtime.read(appMountsFacet);
		$[0] = runtime;
		$[1] = t1;
	} else t1 = $[1];
	const mounts = t1;
	let t2;
	if ($[2] !== mounts) {
		t2 = mounts.map(_temp);
		$[2] = mounts;
		$[3] = t2;
	} else t2 = $[3];
	let t3;
	if ($[4] !== t2) {
		t3 = /* @__PURE__ */ jsx(Fragment$1, { children: t2 });
		$[4] = t2;
		$[5] = t3;
	} else t3 = $[5];
	return t3;
}
function _temp(t0) {
	const { id, component: Component } = t0;
	return /* @__PURE__ */ jsx(ExtensionRenderBoundary, { children: /* @__PURE__ */ jsx(Component, {}) }, id);
}
//#endregion
export { AppRuntimeProvider };

//# sourceMappingURL=AppRuntimeProvider.js.map