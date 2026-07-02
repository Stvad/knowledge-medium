import { m } from "../node_modules/react-error-boundary/dist/react-error-boundary.js";
/* empty css      */
import { setDevAssertionsEnabled } from "./data/internals/devAssertions.js";
import { Login } from "./components/Login.js";
import { installDbForensicsLifecycle } from "./utils/dbForensicsHooks.js";
import { startStartupObservers } from "./utils/startupTimeline.js";
import { RepoProvider } from "./context/repo.js";
import { BootstrapErrorFallback, LocalDbCorruptionSentinel } from "./components/util/error.js";
import { requestPersistentStorage } from "./requestPersistentStorage.js";
import App from "./App.js";
import { SuspenseFallback } from "./components/util/suspense.js";
import { registerServiceWorker } from "./registerServiceWorker.js";
import React, { StrictMode, Suspense } from "react";
import ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/main.tsx
startStartupObservers();
installDbForensicsLifecycle();
setDevAssertionsEnabled(false);
window.React = React;
window.ReactDOM = ReactDOM;
registerServiceWorker();
requestPersistentStorage();
createRoot(document.getElementById("root")).render(/* @__PURE__ */ jsx(StrictMode, { children: /* @__PURE__ */ jsx(Suspense, {
	fallback: /* @__PURE__ */ jsx(SuspenseFallback, {}),
	children: /* @__PURE__ */ jsx(Login, { children: /* @__PURE__ */ jsxs(m, {
		FallbackComponent: BootstrapErrorFallback,
		children: [/* @__PURE__ */ jsx(LocalDbCorruptionSentinel, {}), /* @__PURE__ */ jsx(RepoProvider, { children: /* @__PURE__ */ jsx(Suspense, {
			fallback: /* @__PURE__ */ jsx(SuspenseFallback, {}),
			children: /* @__PURE__ */ jsx(App, {})
		}) })]
	}) })
}) }));
//#endregion

//# sourceMappingURL=main.js.map