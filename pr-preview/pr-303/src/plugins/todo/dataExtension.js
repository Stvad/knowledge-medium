import { propertySchemasFacet, typesFacet } from "../../data/facets.js";
import { roamTodoStateProp, todoType } from "./schema.js";
//#region src/plugins/todo/dataExtension.ts
var todoDataExtension = [propertySchemasFacet.of(roamTodoStateProp, { source: "todo" }), typesFacet.of(todoType, { source: "todo" })];
//#endregion
export { todoDataExtension };

//# sourceMappingURL=dataExtension.js.map