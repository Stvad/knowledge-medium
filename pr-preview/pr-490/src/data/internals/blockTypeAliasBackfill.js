import{ChangeScope as e}from"../api/changeScope.js";import{isTypeSeedKey as t}from"../typeSeeds.js";import"../api/index.js";import{aliasesProp as n,blockTypeLabelProp as r,getAliases as i}from"../properties.js";import{BLOCK_TYPE_TYPE as a}from"../blockTypes.js";import{seededDefinitionKey as o}from"../definitionSeeds.js";var s=`
  SELECT b.id AS id
  FROM blocks b
  JOIN block_types bt ON bt.block_id = b.id AND bt.type = '${a}'
  WHERE b.workspace_id = ?
    AND b.deleted = 0
`,c=100,l={id:`block-type-name-alias-v1`,run:async({workspaceId:a,getAll:l,tx:u})=>{let d=await l(s,[a]);for(let s=0;s<d.length;s+=c){let l=d.slice(s,s+c);await u(async e=>{for(let{id:s}of l){let c=await e.get(s);if(!c||c.deleted||c.workspaceId!==a)continue;let l=o(c);if(l!==void 0&&t(l))continue;let u=c.properties[r.name],d=(typeof u==`string`?u:``).trim();if(d===``)continue;let f=i(c);if(f.includes(d))continue;let p=await e.aliasClaimants(d,a);if(p.some(e=>e.id!==s)){console.warn(`[blockTypeNameAliasBackfill] type ${s} ("${d}") left alias-less: ${p.map(e=>e.id).join(`, `)} already claim(s) that name in workspace ${a}. Rename either side to let [[${d}]] resolve to the type.`);continue}await e.setProperty(s,n,[...f,d])}},{scope:e.BlockDefault,description:`backfill block-type name alias`})}}};export{l as blockTypeNameAliasBackfill};
//# sourceMappingURL=blockTypeAliasBackfill.js.map