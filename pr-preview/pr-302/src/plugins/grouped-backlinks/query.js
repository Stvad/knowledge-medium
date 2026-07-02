import{defineQuery as e}from"../../data/api/query.js";import{array as t,object as n,string as r}from"../../../node_modules/zod/v4/classic/schemas.js";import{backlinksFilterSchema as i}from"../../data/api/typedBlockQuery.js";import"../../data/api/index.js";import{typesProp as a}from"../../data/properties.js";import{buildQualifiedBlockColumnsSql as o}from"../../data/blockSchema.js";import{TYPED_BLOCKS_LABEL_CHANNEL as s,TYPED_BLOCKS_PROPERTY_CHANNEL as c,TYPED_BLOCKS_REFS_OF_CHANNEL as l,TYPED_BLOCKS_STRUCTURE_CHANNEL as u,typedBlocksLabelKey as d,typedBlocksPropertyKey as f,typedBlocksRefsOfKey as p,typedBlocksStructureKey as m}from"../../data/invalidation.js";import{typesFacet as h}from"../../data/facets.js";import{hasBacklinksFilter as g,normalizeBacklinksFilter as _}from"../backlinks/query.js";import{EMPTY_GROUPED_BACKLINKS_CONFIG as v,GROUP_WITH_PROP_NAME as y,normalizeGroupedBacklinksConfig as b}from"./config.js";import{labelForBlockData as x}from"../../utils/linkTargetAutocomplete.js";import{buildGroupedBacklinks as S}from"./grouping.js";var C=`groupedBacklinks.forBlock`,w={parse:e=>e},T=n({highPriorityTags:t(r()).optional(),lowPriorityTags:t(r()).optional(),excludedTags:t(r()).optional(),excludedPatterns:t(r()).optional()}).optional(),E=e=>e,D=(e,t,n)=>{e.depend({kind:`plugin`,channel:u,key:m(t,n)}),e.depend({kind:`plugin`,channel:l,key:p(t,n)})},O=(e,t,n)=>{e.depend({kind:`plugin`,channel:s,key:d(t,n)})},k=async(e,t,n,r)=>(await e.run(`core.typedBlockIds`,{workspaceId:t,referencedBy:{id:n},match:r?.include,exclude:r?.exclude,order:`created-desc`})).filter(e=>e!==n),A=async(e,t,n)=>{if(n.length===0)return[];let r=await e.run(`core.manyAncestors`,{ids:n},{deps:`none`});for(let r of n)D(e,t,r);for(let t of r)for(let n of t.ancestors)D(e,n.workspaceId,n.id);return r.map(e=>({sourceId:e.startId,parentIds:e.ancestors.map(e=>e.id).reverse()}))},j=`source_ids(id) AS (SELECT value FROM json_each(?))`,M=`
  WITH RECURSIVE
    ${j},
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
      JOIN block_references refs ON refs.source_id = ancestor_chain.anc_id
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
`,N=`
  WITH ${j}
  SELECT DISTINCT
    refs.source_id AS source_id,
    refs.source_field AS source_field
  FROM source_ids s
  JOIN block_references refs ON refs.source_id = s.id
  WHERE refs.workspace_id = ?
    AND refs.target_id = ?
    AND refs.source_field != ''
  ORDER BY refs.source_id, refs.source_field
`,P=`
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
`,F=`
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
`,I=e({name:C,argsSchema:n({workspaceId:r(),id:r(),filter:i.optional(),groupingConfig:T}),resultSchema:w,resolve:async({workspaceId:e,id:t,filter:n,groupingConfig:r},i)=>{if(!e||!t)return{groups:[],total:0,unfilteredSourceIds:[],sourceParents:[]};let o=_(n),s=b(r??v);i.depend({kind:`plugin`,channel:u,key:m(e,t)}),i.depend({kind:`plugin`,channel:c,key:f(e,a.name)});let l=await k(i,e,t),d=g(o)?await k(i,e,t,o):l;if(d.length===0)return{groups:[],total:0,unfilteredSourceIds:l,sourceParents:[]};let p=await A(i,e,d),C=JSON.stringify(d),w=await i.db.getAll(M,[C,e,t]),T=await i.db.getAll(N,[C,e,t]),D=new Map;for(let e of w){let t=D.get(e.id);t||(t=new Set,D.set(e.id,t)),t.add(e.source_id)}let j=Array.from(D.keys()),I=j.length===0?`[]`:JSON.stringify(j),L=j.length===0?[]:await i.db.getAll(P,[I,e,y,t]),R=j.length===0?[]:await i.db.getAll(F,[I,e,e,e]),z=i.repo.facetRuntime?.read(h),B=new Map;if(z)for(let e of z.values())B.set(e.id,e.label??e.id);let V=new Map;for(let e of w)V.set(e.id,e);for(let e of L)V.has(e.id)||V.set(e.id,e);let H=i.hydrateBlocks(E(Array.from(V.values())),{declareRowDeps:!1});for(let e of H)O(i,e.workspaceId,e.id);let U=new Map(H.map(e=>[e.id,x(e,e.id)])),W=w.map(e=>({sourceId:e.source_id,groupId:e.id,groupLabel:U.get(e.id)??(e.content.trim()||e.id),kind:e.context_kind===`root`?`root`:`ref`}));for(let e of T)W.push({sourceId:e.source_id,groupId:`field:${e.source_field}`,groupLabel:e.source_field,kind:`field`});for(let e of L){let t=D.get(e.context_id);if(!t)continue;let n=U.get(e.id)??(e.content.trim()||e.id);for(let r of t)W.push({sourceId:r,groupId:e.id,groupLabel:n,kind:`attribute`})}let G=new Set;for(let e of R){let t=D.get(e.context_id);if(!t)continue;let n=`type:${e.type_name}`,r=B.get(e.type_name)??e.type_name;for(let e of t){let t=`${e}\x00${n}`;G.has(t)||(G.add(t),W.push({sourceId:e,groupId:n,groupLabel:r,kind:`type`}))}}return{groups:S({targetId:t,sourceOrder:d,candidates:W,groupingConfig:s}),total:d.length,unfilteredSourceIds:l,sourceParents:p}}});export{C as GROUPED_BACKLINKS_FOR_BLOCK_QUERY,P as SELECT_GROUPED_BACKLINK_ATTRIBUTE_CANDIDATES_SQL,M as SELECT_GROUPED_BACKLINK_CANDIDATES_SQL,N as SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL,F as SELECT_GROUPED_BACKLINK_TYPE_CANDIDATES_SQL,I as groupedBacklinksForBlockQuery};
//# sourceMappingURL=query.js.map