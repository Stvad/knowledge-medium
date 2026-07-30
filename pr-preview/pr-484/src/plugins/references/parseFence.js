import{parseReferences as e}from"./referenceParser.js";var t=`
  SELECT blocks_fts.block_id AS sourceId, b.content AS content
  FROM blocks_fts
  JOIN blocks b
    ON b.id = blocks_fts.block_id
   AND b.workspace_id = blocks_fts.workspace_id
  WHERE blocks_fts.workspace_id = ?
    AND blocks_fts MATCH ?
    AND b.deleted = 0
    AND b.content != ''
  ORDER BY b.order_key, b.id
`,n=e=>`"${e.replace(/"/g,`""`)}"`,r=async(r,i,a)=>a===``?[]:(await r.getAll(t,[i,n(`[[${a}]]`)])).filter(t=>e(t.content).some(e=>e.alias===a)),i=(...e)=>{let t=new Map;for(let n of e)for(let e of n)t.has(e.sourceId)||t.set(e.sourceId,e);return[...t.values()]};export{i as mergeReferrers,r as wikilinkSourcesByContent};
//# sourceMappingURL=parseFence.js.map