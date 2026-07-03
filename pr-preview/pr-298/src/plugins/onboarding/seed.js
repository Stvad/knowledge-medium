import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { aliasesProp } from "../../data/properties.js";
import v4 from "../../../node_modules/uuid/dist/v4.js";
import { PAGE_TYPE } from "../../data/blockTypes.js";
import { keysBetween } from "../../data/orderKey.js";
import { EXTENSIONS_PAGE_TITLE, TUTORIAL_DEFAULT_TITLE, TUTORIAL_VIM_TITLE, extensionsPageOutline, tutorialOutline } from "./outline.js";
//#region src/plugins/onboarding/seed.ts
/**
* Seeds the starter Tutorial subtree on a freshly-created personal
* workspace. Three parent-less pages are written in one tx:
*
*   - `Tutorial` (default / non-vim variant; the landing target — vim is
*     off by default, so this matches the shipped keymap)
*   - `Tutorial (vim)` (variant for users who enable vim mode)
*   - `extensions` (shared page that holds the explanatory bullets and
*     the seven example-extension source blocks; both Tutorial variants
*     link to it via `[[extensions]]` so the examples aren't duplicated)
*
* The two Tutorial variants share one outline builder so their
* structure stays in sync between variants. Reachable from the landing
* daily note via a `[[Tutorial]]` bullet that the daily-notes landing
* resolver prepends on first run; the vim variant is reachable from a
* cross-link bullet at the top of the default Tutorial.
*
* All inserts run in a single `repo.tx` so the whole subtree appears
* atomically AND the cross-page wiki links resolve correctly — every
* alias row exists before `parseReferences` (the post-commit processor)
* runs against the bullets that reference the other pages. Returns the
* id of the default Tutorial so callers can use it as a tutorial-first
* landing target.
*
* The typed demos (todo / char-counter / srs / place / map) tag themselves
* against `repo.snapshotTypeRegistries()` — the Repo's live registry. Those
* plugin types are installed onto the Repo at construction via
* `staticDataExtensions`, so they're present here even though this runs at
* bootstrap, before the React app runtime is applied.
*/
var seedTutorial = async (repo, workspaceId) => {
	const vimTutorialId = v4();
	const defaultTutorialId = v4();
	const extensionsPageId = v4();
	const [vimKey, defaultKey, extensionsKey] = keysBetween(null, null, 3);
	await repo.tx(async (tx) => {
		await seedPage(repo, tx, {
			id: vimTutorialId,
			workspaceId,
			orderKey: vimKey,
			title: TUTORIAL_VIM_TITLE,
			aliases: [TUTORIAL_VIM_TITLE],
			children: tutorialOutline("vim")
		});
		await seedPage(repo, tx, {
			id: defaultTutorialId,
			workspaceId,
			orderKey: defaultKey,
			title: TUTORIAL_DEFAULT_TITLE,
			aliases: [TUTORIAL_DEFAULT_TITLE],
			children: tutorialOutline("default")
		});
		await seedPage(repo, tx, {
			id: extensionsPageId,
			workspaceId,
			orderKey: extensionsKey,
			title: EXTENSIONS_PAGE_TITLE,
			aliases: [EXTENSIONS_PAGE_TITLE],
			children: extensionsPageOutline()
		});
	}, {
		scope: ChangeScope.BlockDefault,
		description: "seed tutorial"
	});
	return defaultTutorialId;
};
var seedPage = async (repo, tx, args) => {
	await tx.create({
		id: args.id,
		workspaceId: args.workspaceId,
		parentId: null,
		orderKey: args.orderKey,
		content: args.title
	});
	await repo.addTypeInTx(tx, args.id, PAGE_TYPE, { [aliasesProp.name]: args.aliases });
	await seedChildren(repo, tx, args.workspaceId, args.id, args.children);
};
var seedChildren = async (repo, tx, workspaceId, parentId, nodes) => {
	if (nodes.length === 0) return;
	const keys = keysBetween(null, null, nodes.length);
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const id = node.id ?? v4();
		await tx.create({
			id,
			workspaceId,
			parentId,
			orderKey: keys[i],
			content: node.content,
			properties: node.properties
		});
		if (node.type) await repo.addTypeInTx(tx, id, node.type, node.typeProperties ?? {});
		if (node.children && node.children.length > 0) await seedChildren(repo, tx, workspaceId, id, node.children);
	}
};
//#endregion
export { seedTutorial };

//# sourceMappingURL=seed.js.map