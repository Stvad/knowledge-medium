import{materializePropertyChildrenForExistingRow as e}from"./propertyChildrenProcessor.js";var t=`properties:cell-to-children`,n=100,r=`
  SELECT b.id AS id
    FROM blocks b
   WHERE b.workspace_id = ?
     AND b.deleted = 0
     AND b.id > ?
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND (SELECT COUNT(*) FROM json_each(b.properties_json)) >
         (SELECT COUNT(*) FROM blocks c
           WHERE c.parent_id = b.id
             AND c.workspace_id = b.workspace_id
             AND c.deleted = 0
             AND c.is_field_form = 1)
   ORDER BY b.id
   LIMIT ?`,i=50,a=async(t,n)=>{let a={blocksScanned:0,blocksMaterialized:0,failures:[]},o=0,s=``;for(;;){let c=await t.getAll(r,[t.workspaceId,s,100]);if(c.length===0)break;s=c[c.length-1].id,await t.tx(async n=>{for(let{id:r}of c){a.blocksScanned+=1;let s=await n.get(r);if(!(s===null||s.deleted))try{await e(n,s,{resolveNameSchema:t.resolveNameSchema}),a.blocksMaterialized+=1}catch(e){o+=1,a.failures.length<i&&a.failures.push({blockId:r,reason:e instanceof Error?e.message:String(e)})}}},{description:`Migrate properties to child blocks`}),n?.(a)}return o>a.failures.length&&a.failures.push({blockId:`(truncated)`,reason:`${o-a.failures.length} further blocks failed; only the first ${i} are listed.`}),a},o={id:t,trigger:`operator`,run:async e=>{let n=await a(e,e=>{console.info(`[${t}] ${e.blocksMaterialized}/${e.blocksScanned} blocks`)});n.failures.length>0&&console.warn(`[${t}] ${n.failures.length} block(s) could not be migrated and kept cell-only values:`,n.failures)}};export{n as PROPERTY_CELL_BACKFILL_BATCH,t as PROPERTY_CELL_BACKFILL_ID,o as propertyCellBackfill,a as runPropertyCellBackfill};
//# sourceMappingURL=propertyCellBackfill.js.map