import { createClient } from "../../node_modules/@supabase/supabase-js/dist/index.js";
//#region src/services/supabase.ts
var supabaseUrl = "https://plgyaxwcrzoazkapnqqo.supabase.co"?.trim();
var supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsZ3lheHdjcnpvYXprYXBucXFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0NDgxMzMsImV4cCI6MjA5NDAyNDEzM30.u8OWy2477Ghk8FrXdXYfNzefAzg6ZVAPEa4rOMzct08"?.trim();
var hasSupabaseAuthConfig = Boolean(supabaseUrl && supabaseAnonKey);
var supabase = hasSupabaseAuthConfig ? createClient(supabaseUrl, supabaseAnonKey, { auth: {
	autoRefreshToken: true,
	persistSession: true,
	detectSessionInUrl: true
} }) : null;
var supabaseAuthStorageKey = supabaseUrl ? `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token` : null;
var readPersistedSession = () => {
	if (!supabaseAuthStorageKey || typeof window === "undefined") return null;
	let raw;
	try {
		raw = window.localStorage.getItem(supabaseAuthStorageKey);
	} catch {
		return null;
	}
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		const candidate = parsed?.access_token ? parsed : parsed?.currentSession ?? parsed?.session ?? null;
		return candidate?.access_token && candidate?.user ? candidate : null;
	} catch {
		return null;
	}
};
var isAuthCallbackUrl = () => {
	if (!supabaseAuthStorageKey || typeof window === "undefined") return false;
	const { search, hash } = window.location;
	const params = new URLSearchParams(search);
	const hashParams = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
	const has = (key) => params.has(key) || hashParams.has(key);
	if (has("access_token") || has("error_description")) return true;
	if (has("code")) try {
		return window.localStorage.getItem(`${supabaseAuthStorageKey}-code-verifier`) !== null;
	} catch {
		return false;
	}
	return false;
};
var getUserName = (user) => {
	const metadataName = typeof user.user_metadata?.name === "string" ? user.user_metadata.name.trim() : "";
	if (metadataName) return metadataName;
	if (user.email) return user.email;
	if ("is_anonymous" in user && user.is_anonymous === true) return "Anonymous";
	return `User ${user.id.slice(0, 8)}`;
};
var sessionUserToAppUser = (session) => ({
	id: session.user.id,
	name: getUserName(session.user)
});
//#endregion
export { hasSupabaseAuthConfig, isAuthCallbackUrl, readPersistedSession, sessionUserToAppUser, supabase };

//# sourceMappingURL=supabase.js.map