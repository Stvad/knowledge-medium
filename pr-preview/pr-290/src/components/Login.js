import { Input } from "./ui/input.js";
import { Button } from "./ui/button.js";
import useLocalStorage from "../../node_modules/react-use/esm/useLocalStorage.js";
import { hasSupabaseAuthConfig, isAuthCallbackUrl, readPersistedSession, sessionUserToAppUser, supabase } from "../services/supabase.js";
import { hasRemoteSyncConfig } from "../services/powersync.js";
import { createContext, useContext, useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/Login.tsx
var UserContext = createContext(void 0);
var useUser = () => {
	const context = useContext(UserContext);
	if (!context) throw new Error("useUser must be used within a Login component");
	return context.user;
};
var useSignOut = () => {
	const context = useContext(UserContext);
	if (!context) throw new Error("useSignOut must be used within a Login component");
	return context.signOut;
};
/** True when the active session has remote sync disabled. Use this to gate
*  Supabase RPC calls and UI that only makes sense with a remote backend
*  (member management, invitations, etc.). */
var useIsLocalOnly = () => {
	const context = useContext(UserContext);
	if (!context) throw new Error("useIsLocalOnly must be used within a Login component");
	return context.localOnly;
};
var LOCAL_ONLY_STORAGE_KEY = "ftm.localOnly";
var clearLocalOnlyOptIn = () => {
	try {
		window.localStorage.removeItem(LOCAL_ONLY_STORAGE_KEY);
	} catch {}
};
function Login(t0) {
	const $ = c(7);
	const { children } = t0;
	const [localOnlyOptIn, setLocalOnlyOptIn] = useLocalStorage(LOCAL_ONLY_STORAGE_KEY, false);
	const supabaseAvailable = hasSupabaseAuthConfig && supabase;
	if (supabaseAvailable && !localOnlyOptIn) {
		let t1;
		if ($[0] !== setLocalOnlyOptIn) {
			t1 = () => setLocalOnlyOptIn(true);
			$[0] = setLocalOnlyOptIn;
			$[1] = t1;
		} else t1 = $[1];
		let t2;
		if ($[2] !== children || $[3] !== t1) {
			t2 = /* @__PURE__ */ jsx(SupabaseLogin, {
				onContinueLocally: t1,
				children
			});
			$[2] = children;
			$[3] = t1;
			$[4] = t2;
		} else t2 = $[4];
		return t2;
	}
	let t1;
	if ($[5] !== children) {
		t1 = /* @__PURE__ */ jsx(LocalLogin, {
			clearLocalOnlyOnSignOut: Boolean(supabaseAvailable),
			children
		});
		$[5] = children;
		$[6] = t1;
	} else t1 = $[6];
	return t1;
}
function LocalLogin(t0) {
	const $ = c(30);
	const { children, clearLocalOnlyOnSignOut } = t0;
	const [user, setUser, clearUser] = useLocalStorage("ftm.user", void 0);
	const [name, setName] = useState("");
	if (user) {
		let t1;
		if ($[0] !== clearLocalOnlyOnSignOut || $[1] !== clearUser) {
			t1 = async () => {
				clearUser();
				setName("");
				if (clearLocalOnlyOnSignOut) {
					clearLocalOnlyOptIn();
					window.location.reload();
				}
			};
			$[0] = clearLocalOnlyOnSignOut;
			$[1] = clearUser;
			$[2] = t1;
		} else t1 = $[2];
		const signOut = t1;
		let t2;
		if ($[3] !== setUser || $[4] !== signOut || $[5] !== user) {
			t2 = {
				user,
				setUser,
				signOut,
				localOnly: true
			};
			$[3] = setUser;
			$[4] = signOut;
			$[5] = user;
			$[6] = t2;
		} else t2 = $[6];
		let t3;
		if ($[7] !== children || $[8] !== t2) {
			t3 = /* @__PURE__ */ jsx(UserContext, {
				value: t2,
				children
			});
			$[7] = children;
			$[8] = t2;
			$[9] = t3;
		} else t3 = $[9];
		return t3;
	}
	let t1;
	if ($[10] !== name) {
		t1 = name.trim();
		$[10] = name;
		$[11] = t1;
	} else t1 = $[11];
	const userName = t1;
	let t2;
	if ($[12] !== setUser || $[13] !== userName) {
		t2 = () => {
			if (userName) setUser({
				id: userName,
				name: userName
			});
		};
		$[12] = setUser;
		$[13] = userName;
		$[14] = t2;
	} else t2 = $[14];
	const updateUser = t2;
	const cancelLocalOnly = _temp;
	let t3;
	if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsx("h1", {
			className: "text-2xl font-bold text-center",
			children: "Thought Medium"
		});
		$[15] = t3;
	} else t3 = $[15];
	let t4;
	if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = (e) => setName(e.target.value);
		$[16] = t4;
	} else t4 = $[16];
	let t5;
	if ($[17] !== updateUser) {
		t5 = (e_0) => {
			if (e_0.key === "Enter") updateUser();
		};
		$[17] = updateUser;
		$[18] = t5;
	} else t5 = $[18];
	let t6;
	if ($[19] !== name || $[20] !== t5) {
		t6 = /* @__PURE__ */ jsx(Input, {
			placeholder: "Enter your name",
			value: name,
			onChange: t4,
			onKeyDown: t5
		});
		$[19] = name;
		$[20] = t5;
		$[21] = t6;
	} else t6 = $[21];
	let t7;
	if ($[22] !== updateUser) {
		t7 = /* @__PURE__ */ jsx(Button, {
			className: "w-full",
			onClick: () => updateUser(),
			children: "Enter"
		});
		$[22] = updateUser;
		$[23] = t7;
	} else t7 = $[23];
	let t8;
	if ($[24] !== clearLocalOnlyOnSignOut) {
		t8 = clearLocalOnlyOnSignOut && /* @__PURE__ */ jsx(Button, {
			variant: "ghost",
			className: "w-full",
			onClick: cancelLocalOnly,
			children: "Back to sign in"
		});
		$[24] = clearLocalOnlyOnSignOut;
		$[25] = t8;
	} else t8 = $[25];
	let t9;
	if ($[26] !== t6 || $[27] !== t7 || $[28] !== t8) {
		t9 = /* @__PURE__ */ jsx("div", {
			className: "flex flex-col items-center justify-center min-h-screen px-6",
			children: /* @__PURE__ */ jsxs("div", {
				className: "w-full max-w-sm space-y-4",
				children: [t3, /* @__PURE__ */ jsxs("div", {
					className: "space-y-2",
					children: [
						t6,
						t7,
						t8
					]
				})]
			})
		});
		$[26] = t6;
		$[27] = t7;
		$[28] = t8;
		$[29] = t9;
	} else t9 = $[29];
	return t9;
}
function _temp() {
	clearLocalOnlyOptIn();
	window.location.reload();
}
var seedSession = () => isAuthCallbackUrl() ? null : readPersistedSession();
function SupabaseLogin(t0) {
	const $ = c(44);
	const { children, onContinueLocally } = t0;
	const [session, setSession] = useState(seedSession);
	let t1;
	if ($[0] !== session) {
		t1 = () => session === null;
		$[0] = session;
		$[1] = t1;
	} else t1 = $[1];
	const [initializing, setInitializing] = useState(t1);
	const [stage, setStage] = useState("enter-email");
	const [submitting, setSubmitting] = useState(false);
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState(null);
	const [info, setInfo] = useState(null);
	let t2;
	let t3;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = () => {
			let isMounted = true;
			const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
				if (!isMounted) return;
				setInitializing(false);
				if (next) {
					setSession(next);
					setError(null);
					setCode("");
					return;
				}
				if (event === "SIGNED_OUT") setSession(null);
			});
			return () => {
				isMounted = false;
				listener.subscription.unsubscribe();
			};
		};
		t3 = [supabase];
		$[2] = t2;
		$[3] = t3;
	} else {
		t2 = $[2];
		t3 = $[3];
	}
	useEffect(t2, t3);
	if (initializing) {
		let t4;
		if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
			t4 = /* @__PURE__ */ jsx("div", {
				className: "flex min-h-screen items-center justify-center",
				children: /* @__PURE__ */ jsx("div", {
					className: "text-sm text-muted-foreground",
					children: "Loading…"
				})
			});
			$[4] = t4;
		} else t4 = $[4];
		return t4;
	}
	if (session) {
		let t4;
		if ($[5] !== session) {
			t4 = sessionUserToAppUser(session);
			$[5] = session;
			$[6] = t4;
		} else t4 = $[6];
		const user = t4;
		const signOut = _temp2;
		let t5;
		if ($[7] !== user) {
			t5 = {
				user,
				setUser: _temp3,
				signOut,
				localOnly: !hasRemoteSyncConfig
			};
			$[7] = user;
			$[8] = t5;
		} else t5 = $[8];
		let t6;
		if ($[9] !== children || $[10] !== t5) {
			t6 = /* @__PURE__ */ jsx(UserContext, {
				value: t5,
				children
			});
			$[9] = children;
			$[10] = t5;
			$[11] = t6;
		} else t6 = $[11];
		return t6;
	}
	let t4;
	if ($[12] !== email) {
		t4 = async (event_0) => {
			event_0.preventDefault();
			const trimmed = email.trim();
			if (!trimmed) return;
			setError(null);
			setInfo(null);
			setSubmitting(true);
			const { error: err_0 } = await supabase.auth.signInWithOtp({
				email: trimmed,
				options: { shouldCreateUser: true }
			});
			setSubmitting(false);
			if (err_0) {
				setError(err_0.message);
				return;
			}
			setStage("enter-code");
			setInfo(`We sent a 6-digit code to ${trimmed}.`);
		};
		$[12] = email;
		$[13] = t4;
	} else t4 = $[13];
	const requestCode = t4;
	let t5;
	if ($[14] !== code || $[15] !== email) {
		t5 = async (event_1) => {
			event_1.preventDefault();
			const trimmedCode = code.trim();
			const trimmedEmail = email.trim();
			if (!trimmedCode || !trimmedEmail) return;
			setError(null);
			setSubmitting(true);
			const { error: err_1 } = await supabase.auth.verifyOtp({
				email: trimmedEmail,
				token: trimmedCode,
				type: "email"
			});
			setSubmitting(false);
			if (err_1) {
				setError(err_1.message);
				return;
			}
		};
		$[14] = code;
		$[15] = email;
		$[16] = t5;
	} else t5 = $[16];
	const verifyCode = t5;
	let t6;
	if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = async () => {
			setError(null);
			setInfo(null);
			setSubmitting(true);
			const { error: err_2 } = await supabase.auth.signInAnonymously();
			setSubmitting(false);
			if (err_2) setError(err_2.message);
		};
		$[17] = t6;
	} else t6 = $[17];
	const continueAnonymously = t6;
	let t7;
	if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
		t7 = () => {
			setStage("enter-email");
			setCode("");
			setError(null);
			setInfo(null);
		};
		$[18] = t7;
	} else t7 = $[18];
	const useDifferentEmail = t7;
	let t8;
	if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = /* @__PURE__ */ jsx("h1", {
			className: "text-2xl font-bold text-center",
			children: "Thought Medium"
		});
		$[19] = t8;
	} else t8 = $[19];
	let t9;
	if ($[20] !== code || $[21] !== email || $[22] !== info || $[23] !== requestCode || $[24] !== stage || $[25] !== submitting || $[26] !== verifyCode) {
		t9 = stage === "enter-code" ? /* @__PURE__ */ jsxs("form", {
			onSubmit: verifyCode,
			className: "space-y-3",
			children: [
				info && /* @__PURE__ */ jsx("p", {
					className: "text-sm text-muted-foreground text-center",
					children: info
				}),
				/* @__PURE__ */ jsx(Input, {
					autoFocus: true,
					inputMode: "numeric",
					pattern: "[0-9]*",
					placeholder: "6-digit code",
					value: code,
					onChange: (e) => setCode(e.target.value),
					disabled: submitting
				}),
				/* @__PURE__ */ jsx(Button, {
					type: "submit",
					className: "w-full",
					disabled: submitting || !code.trim(),
					children: submitting ? "Verifying…" : "Verify"
				}),
				/* @__PURE__ */ jsx(Button, {
					type: "button",
					variant: "ghost",
					className: "w-full",
					onClick: useDifferentEmail,
					disabled: submitting,
					children: "Use a different email"
				})
			]
		}) : /* @__PURE__ */ jsxs("form", {
			onSubmit: requestCode,
			className: "space-y-3",
			children: [/* @__PURE__ */ jsx(Input, {
				autoFocus: true,
				type: "email",
				placeholder: "you@example.com",
				value: email,
				onChange: (e_0) => setEmail(e_0.target.value),
				disabled: submitting
			}), /* @__PURE__ */ jsx(Button, {
				type: "submit",
				className: "w-full",
				disabled: submitting || !email.trim(),
				children: submitting ? "Sending…" : "Send sign-in code"
			})]
		});
		$[20] = code;
		$[21] = email;
		$[22] = info;
		$[23] = requestCode;
		$[24] = stage;
		$[25] = submitting;
		$[26] = verifyCode;
		$[27] = t9;
	} else t9 = $[27];
	let t10;
	if ($[28] !== error) {
		t10 = error && /* @__PURE__ */ jsx("p", {
			className: "text-sm text-destructive text-center",
			children: error
		});
		$[28] = error;
		$[29] = t10;
	} else t10 = $[29];
	let t11;
	if ($[30] === Symbol.for("react.memo_cache_sentinel")) {
		t11 = /* @__PURE__ */ jsx("div", {
			className: "text-xs text-muted-foreground text-center uppercase tracking-wide",
			children: "or"
		});
		$[30] = t11;
	} else t11 = $[30];
	let t12;
	if ($[31] !== submitting) {
		t12 = /* @__PURE__ */ jsx(Button, {
			type: "button",
			variant: "outline",
			className: "w-full",
			onClick: continueAnonymously,
			disabled: submitting,
			children: "Continue without an account"
		});
		$[31] = submitting;
		$[32] = t12;
	} else t12 = $[32];
	let t13;
	if ($[33] === Symbol.for("react.memo_cache_sentinel")) {
		t13 = /* @__PURE__ */ jsx("p", {
			className: "text-xs text-muted-foreground text-center",
			children: "Anonymous sessions are per-device. Sign in with email to invite collaborators."
		});
		$[33] = t13;
	} else t13 = $[33];
	let t14;
	if ($[34] !== onContinueLocally || $[35] !== submitting) {
		t14 = /* @__PURE__ */ jsx(Button, {
			type: "button",
			variant: "ghost",
			className: "w-full",
			onClick: onContinueLocally,
			disabled: submitting,
			children: "Use without sync (local-only)"
		});
		$[34] = onContinueLocally;
		$[35] = submitting;
		$[36] = t14;
	} else t14 = $[36];
	let t15;
	if ($[37] !== t12 || $[38] !== t14) {
		t15 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-2",
			children: [
				t11,
				t12,
				t13,
				t14
			]
		});
		$[37] = t12;
		$[38] = t14;
		$[39] = t15;
	} else t15 = $[39];
	let t16;
	if ($[40] !== t10 || $[41] !== t15 || $[42] !== t9) {
		t16 = /* @__PURE__ */ jsx("div", {
			className: "flex flex-col items-center justify-center min-h-screen px-6",
			children: /* @__PURE__ */ jsxs("div", {
				className: "w-full max-w-sm space-y-6",
				children: [
					t8,
					t9,
					t10,
					t15
				]
			})
		});
		$[40] = t10;
		$[41] = t15;
		$[42] = t9;
		$[43] = t16;
	} else t16 = $[43];
	return t16;
}
function _temp3() {}
async function _temp2() {
	const { error: err } = await supabase.auth.signOut();
	if (err) console.error("Sign-out failed", err);
	window.location.reload();
}
//#endregion
export { Login, useIsLocalOnly, useSignOut, useUser };

//# sourceMappingURL=Login.js.map