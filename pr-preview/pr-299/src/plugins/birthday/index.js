import { systemToggle } from "../../facets/togglable.js";
import { appMountsFacet } from "../../extensions/core.js";
import { BirthdayCelebration } from "./BirthdayCelebration.js";
//#region src/plugins/birthday/index.ts
/**
* A one-day, recipient-targeted birthday surprise: flips the app into a
* midnight "wolf" theme (with tiny-wolf bullets) and plays a dramatic
* howling-wolf overlay. Targeting is a hashed user-id gate (no PII in the
* bundle) plus a local-date check; everyone else gets nothing. See
* `gate.ts` and `wolfTheme.ts`.
*/
var birthdayPlugin = systemToggle({
	id: "system:birthday",
	name: "Birthday surprise",
	description: "A one-day wolf-themed birthday celebration for the day’s birthday-haver."
}).of([appMountsFacet.of({
	id: "birthday.celebration",
	component: BirthdayCelebration
}, { source: "birthday" })]);
//#endregion
export { birthdayPlugin };

//# sourceMappingURL=index.js.map