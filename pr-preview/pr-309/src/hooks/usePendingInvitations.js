import { listMyPendingInvitations } from "../data/workspaces.js";
import { useCallback, useEffect, useState } from "react";
//#region src/hooks/usePendingInvitations.ts
var usePendingInvitations = () => {
	const [invitations, setInvitations] = useState([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState(null);
	const refresh = useCallback(async () => {
		setError(null);
		try {
			setInvitations(await listMyPendingInvitations());
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load invitations");
		} finally {
			setIsLoading(false);
		}
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);
	return {
		invitations,
		isLoading,
		error,
		refresh
	};
};
//#endregion
export { usePendingInvitations };

//# sourceMappingURL=usePendingInvitations.js.map