import{parseReferences as e}from"./referenceParser.js";import{isExtensionSource as t}from"./referencesProcessor.js";var n=e=>{if(e===null)return{};try{let t=JSON.parse(e);return typeof t==`object`&&t&&!Array.isArray(t)?t:{}}catch{return{}}},r=`
  SELECT blocks_fts.block_id AS sourceId, b.content AS content,
         b.properties_json AS propertiesJson
  FROM blocks_fts
  JOIN blocks b
    ON b.id = blocks_fts.block_id
   AND b.workspace_id = blocks_fts.workspace_id
  WHERE blocks_fts.workspace_id = ?
    AND blocks_fts MATCH ?
    AND b.deleted = 0
    AND b.content != ''
  ORDER BY b.order_key, b.id
`,i=`
  SELECT b.id AS sourceId, b.content AS content,
         b.properties_json AS propertiesJson
  FROM blocks b
  WHERE b.workspace_id = ?
    AND instr(b.content, ?) > 0
    AND b.deleted = 0
    AND b.content != ''
  ORDER BY b.order_key, b.id
`,a=e=>`"${e.replace(/"/g,`""`)}"`,o=e=>e.includes(`\0`),s=async(s,c,l)=>{if(l===``)return[];let u=`[[${l}]]`;return(await s.getAll(o(u)?i:r,[c,o(u)?u:a(u)])).filter(e=>!t({properties:n(e.propertiesJson)})).filter(t=>e(t.content).some(e=>e.alias===l)).map(({sourceId:e,content:t})=>({sourceId:e,content:t}))},c=(...e)=>{let t=new Map;for(let n of e)for(let e of n)t.has(e.sourceId)||t.set(e.sourceId,e);return[...t.values()]};export{c as mergeReferrers,s as wikilinkSourcesByContent};
//# sourceMappingURL=parseFence.js.map