import{propertyNameProp as e}from"../properties.js";import{PROPERTY_SCHEMA_TYPE as t}from"../blockTypes.js";var n=`json_valid(b.properties_json) AND json_type(b.properties_json) = 'object'`,r=`CASE WHEN ${n} THEN b.properties_json ELSE '{}' END`,i=`NOT (${n})`,a=e=>typeof e==`string`?e:String(e??``),o=(e,t)=>{let n=e.propertyDefinitions;if(!n||n.workspaceId!==t)throw Error(`Cannot read property keys for ${t}: its property-definition registry is not loaded (loaded: ${n?.workspaceId??`none`}). Every key would read as unregistered. Open that workspace in the app and re-run.`);return n},s=async(n,s)=>{o(n,s),await n.whenPropertyDefinitionsReady(s);let c=await n.syncViewGap(),l=o(n,s),u=n.propertySchemaResolverFor(s),d=await n.db.getAll(`SELECT j.key AS property,
            COUNT(*) AS cells,
            SUM(j.type IN ('true','false')) AS booleans,
            SUM(j.type IN ('integer','real')) AS numbers,
            SUM(j.type = 'text') AS texts,
            SUM(j.type NOT IN ('true','false','integer','real','text')) AS others
       FROM blocks b, json_each(${r}) j
      WHERE b.workspace_id = ? AND b.deleted = 0
      GROUP BY j.key`,[s]),f=await n.db.get(`SELECT COUNT(*) AS n FROM blocks b
      WHERE b.workspace_id = ? AND b.deleted = 0 AND ${i}`,[s]),p=await n.db.getAll(`SELECT b.id AS id, json_extract(${r}, ?) AS name
       FROM blocks b
       JOIN block_types t ON t.block_id = b.id AND t.workspace_id = b.workspace_id
      WHERE t.type = ? AND b.workspace_id = ? AND b.deleted = 0`,[`$."${e.name}"`,t,s]),m=new Map;for(let e of p){let t=l.definitionsByFieldId.get(e.id)?.name??(typeof e.name==`string`?e.name:void 0);t!==void 0&&m.set(t,(m.get(t)??0)+1)}let h=[],g=0,_=0;for(let e of d){let t=a(e.property);_+=e.cells;let n=u.resolve(t);if(n.status===`resolved`){g+=1;continue}h.push({property:t,cells:e.cells,valueTypes:{booleans:e.booleans,numbers:e.numbers,texts:e.texts,others:e.others},reason:n.reason,definitionBlocks:m.get(t)??0})}return h.sort((e,t)=>t.cells-e.cells||e.property.localeCompare(t.property)),{workspaceId:s,syncGap:c,distinctProperties:d.length,propertyCells:_,registeredProperties:g,unresolved:h,unreadableBlocks:f?.n??0}};export{r as OBJECT_BAG,a as keyOf,s as scanPropertyKeys};
//# sourceMappingURL=propertyKeyScan.js.map