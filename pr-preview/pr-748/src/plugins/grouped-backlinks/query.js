import{defineQuery as e}from"../../data/api/query.js";import{array as t,object as n,string as r}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{backlinksFilterSchema as i}from"../../data/api/typedBlockQuery.js";import"../../data/api/index.js";import{typesProp as a}from"../../data/properties.js";import{buildQualifiedBlockColumnsSql as o}from"../../data/blockSchema.js";import{TYPED_BLOCKS_LABEL_CHANNEL as s,TYPED_BLOCKS_PROPERTY_CHANNEL as c,TYPED_BLOCKS_REFS_OF_CHANNEL as l,TYPED_BLOCKS_STRUCTURE_CHANNEL as u,typedBlocksLabelKey as d,typedBlocksPropertyKey as f,typedBlocksRefsOfKey as p,typedBlocksStructureKey as m}from"../../data/invalidation.js";import{registrySeedParams as h}from"../../data/internals/kernelQueries.js";import{labelForBlockData as g}from"../../utils/linkTargetAutocomplete.js";import{hasBacklinksFilter as _,normalizeBacklinksFilter as v,propertyMachinerySourceIds as y,workspaceHasPropertyMachinery as b}from"../backlinks/query.js";import{EMPTY_GROUPED_BACKLINKS_CONFIG as x,GROUP_WITH_PROP_NAME as S,normalizeGroupedBacklinksConfig as C}from"./config.js";import{buildGroupedBacklinks as w}from"./grouping.js";var T=`groupedBacklinks.forBlock`,E={parse:e=>e},D=n({highPriorityTags:t(r()).optional(),lowPriorityTags:t(r()).optional(),excludedTags:t(r()).optional(),excludedPatterns:t(r()).optional()}).optional(),O=e=>e,k=(e,t,n)=>{e.depend({kind:`plugin`,channel:u,key:m(t,n)}),e.depend({kind:`plugin`,channel:l,key:p(t,n)})},A=(e,t,n)=>{e.depend({kind:`plugin`,channel:s,key:d(t,n)})},j=async(e,t,n,r)=>{let i=(await e.run(`core.typedBlockIds`,{workspaceId:t,referencedBy:{id:n},match:r?.include,exclude:r?.exclude,order:`created-desc`})).filter(e=>e!==n);if(i.length===0||!await b(e.db,t))return i;let a=await y(e.db,i,h(e.repo));return a.size===0?i:i.filter(e=>!a.has(e))},M=async(e,t,n)=>{if(n.length===0)return[];let r=await e.run(`core.manyAncestors`,{ids:n},{deps:`none`});for(let r of n)k(e,t,r);for(let t of r)for(let n of t.ancestors)k(e,n.workspaceId,n.id);return r.map(e=>({sourceId:e.startId,parentIds:e.ancestors.map(e=>e.id).reverse()}))},N=`source_ids(id) AS (SELECT value FROM json_each(?))`,P=`
  WITH ${N}
  SELECT ${o(`b`)}
  FROM source_ids s
  JOIN blocks b ON b.id = s.id
  WHERE b.deleted = 0
`,F=`
  WITH RECURSIVE
    ${N},
    ancestor_chain(source_id, anc_id, anc_parent_id, depth, path) AS (
      SELECT s.id, b.id, b.parent_id, 0, '!' || hex(b.id) || '/'
      FROM source_ids s
      JOIN blocks b ON b.id = s.id
      WHERE b.deleted = 0
      UNION ALL
      SELECT
        ancestor_chain.source_id,
        parent.id,
        parent.parent_id,
        ancestor_chain.depth + 1,
        ancestor_chain.path || '!' || hex(parent.id) || '/'
      FROM ancestor_chain
      JOIN blocks parent ON parent.id = ancestor_chain.anc_parent_id
      WHERE parent.deleted = 0
        AND ancestor_chain.depth < 100
        AND INSTR(ancestor_chain.path, '!' || hex(parent.id) || '/') = 0
    ),
    group_context_refs AS (
      SELECT DISTINCT
        ancestor_chain.source_id,
        refs.target_id AS context_id,
        'ref' AS context_kind
      FROM ancestor_chain
      -- CROSS JOIN pins the join ORDER (results are identical either way).
      -- Here refs is constrained only by workspace_id -- no target_id, unlike
      -- the sibling statements -- so idx_block_references_ws_alias looks usable
      -- on its leading column, and a recursive CTE carries no cardinality
      -- estimate for the planner to weigh against it. It therefore drove from
      -- every edge in the workspace and built a throwaway index on the chain,
      -- instead of probing the (source_id, ...) primary key once per chain row.
      -- ANALYZE does not fix this: the table stats are already right, it is the
      -- CTE's size that is unknown.
      CROSS JOIN block_references refs ON refs.source_id = ancestor_chain.anc_id
      WHERE refs.workspace_id = ?
        AND (refs.source_field = '' OR refs.target_id != ?)
      UNION
      SELECT
        ancestor_chain.source_id,
        ancestor_chain.anc_id AS context_id,
        'root' AS context_kind
      FROM ancestor_chain
      WHERE ancestor_chain.anc_parent_id IS NULL
    )
  SELECT DISTINCT
    cr.source_id AS source_id,
    cr.context_kind AS context_kind,
    ${o(`group_block`)}
  FROM group_context_refs cr
  JOIN blocks group_block ON group_block.id = cr.context_id
  WHERE group_block.deleted = 0
  ORDER BY cr.source_id, coalesce(group_block.user_updated_at, group_block.updated_at) DESC, group_block.id
`,I=`
  WITH ${N}
  SELECT DISTINCT
    refs.source_id AS source_id,
    refs.source_field AS source_field
  FROM source_ids s
  JOIN block_references refs ON refs.source_id = s.id
  WHERE refs.workspace_id = ?
    AND refs.target_id = ?
    AND refs.source_field != ''
  ORDER BY refs.source_id, refs.source_field
`,L=`
  WITH context_ids(id) AS (SELECT value FROM json_each(?))
  SELECT DISTINCT
    refs.source_id AS context_id,
    ${o(`group_block`)}
  FROM context_ids c
  JOIN block_references refs ON refs.source_id = c.id
  JOIN blocks group_block ON group_block.id = refs.target_id
  WHERE refs.workspace_id = ?
    AND refs.source_field = ?
    AND refs.target_id != ?
    AND group_block.deleted = 0
  ORDER BY refs.source_id, coalesce(group_block.user_updated_at, group_block.updated_at) DESC, group_block.id
`,R=`
  WITH context_ids(id) AS (SELECT value FROM json_each(?))
  SELECT bt.block_id AS context_id, bt.type AS type_name
    FROM context_ids c
    JOIN block_types bt
      ON bt.block_id = c.id
     AND bt.workspace_id = ?
  UNION
  SELECT refs.source_id AS context_id, bt.type AS type_name
    FROM context_ids c
    JOIN block_references refs
      ON refs.source_id = c.id
     AND refs.workspace_id = ?
    JOIN block_types bt
      ON bt.block_id = refs.target_id
     AND bt.workspace_id = ?
  ORDER BY context_id, type_name
`,z=e({name:T,argsSchema:n({workspaceId:r(),id:r(),filter:i.optional(),groupingConfig:D}),resultSchema:E,resolve:async({workspaceId:e,id:t,filter:n,groupingConfig:r},i)=>{if(!e||!t)return{groups:[],total:0,unfilteredSourceIds:[],sourceParents:[]};let o=v(n),s=C(r??x);i.depend({kind:`plugin`,channel:u,key:m(e,t)}),i.depend({kind:`plugin`,channel:c,key:f(e,a.name)});let l=await j(i,e,t),d=_(o)?await j(i,e,t,o):l;if(d.length===0)return{groups:[],total:0,unfilteredSourceIds:l,sourceParents:[]};let p=await M(i,e,d),h=JSON.stringify(d),y=await i.db.getAll(P,[h]);i.hydrateBlocks(O(y),{declareRowDeps:!1});let b=await i.db.getAll(F,[h,e,t]),T=await i.db.getAll(I,[h,e,t]),E=new Map;for(let e of b){let t=E.get(e.id);t||(t=new Set,E.set(e.id,t)),t.add(e.source_id)}let D=Array.from(E.keys()),k=D.length===0?`[]`:JSON.stringify(D),N=D.length===0?[]:await i.db.getAll(L,[k,e,S,t]),z=D.length===0?[]:await i.db.getAll(R,[k,e,e,e]),B=i.repo.types,V=new Map;for(let e of B.values())V.set(e.id,e.label??e.id);let H=new Map;for(let e of b)H.set(e.id,e);for(let e of N)H.has(e.id)||H.set(e.id,e);let U=i.hydrateBlocks(O(Array.from(H.values())),{declareRowDeps:!1});for(let e of U)A(i,e.workspaceId,e.id);let W=new Map(U.map(e=>[e.id,g(e,e.id)])),G=b.map(e=>({sourceId:e.source_id,groupId:e.id,groupLabel:W.get(e.id)??(e.content.trim()||e.id),kind:e.context_kind===`root`?`root`:`ref`}));for(let e of T)G.push({sourceId:e.source_id,groupId:`field:${e.source_field}`,groupLabel:e.source_field,kind:`field`});for(let e of N){let t=E.get(e.context_id);if(!t)continue;let n=W.get(e.id)??(e.content.trim()||e.id);for(let r of t)G.push({sourceId:r,groupId:e.id,groupLabel:n,kind:`attribute`})}let K=new Set;for(let e of z){let t=E.get(e.context_id);if(!t)continue;let n=`type:${e.type_name}`,r=V.get(e.type_name)??e.type_name;for(let e of t){let t=`${e}\x00${n}`;K.has(t)||(K.add(t),G.push({sourceId:e,groupId:n,groupLabel:r,kind:`type`}))}}return{groups:w({targetId:t,sourceOrder:d,candidates:G,groupingConfig:s}),total:d.length,unfilteredSourceIds:l,sourceParents:p}}});export{T as GROUPED_BACKLINKS_FOR_BLOCK_QUERY,L as SELECT_GROUPED_BACKLINK_ATTRIBUTE_CANDIDATES_SQL,F as SELECT_GROUPED_BACKLINK_CANDIDATES_SQL,I as SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL,P as SELECT_GROUPED_BACKLINK_MEMBER_ROWS_SQL,R as SELECT_GROUPED_BACKLINK_TYPE_CANDIDATES_SQL,z as groupedBacklinksForBlockQuery};
//# sourceMappingURL=query.js.map