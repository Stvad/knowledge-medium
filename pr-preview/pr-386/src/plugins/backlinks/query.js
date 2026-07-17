import{defineQuery as e}from"../../data/api/query.js";import{boolean as t,object as n,string as r}from"../../../node_modules/zod/v4/classic/schemas.js";import{backlinksFilterSchema as i}from"../../data/api/typedBlockQuery.js";import"../../data/api/index.js";import a from"../../../node_modules/lodash-es/isEqual.js";import{readIsChildBackedWorkspace as o}from"../../data/workspaceSchema.js";import{TYPED_BLOCKS_STRUCTURE_CHANNEL as s,typedBlocksStructureKey as c}from"../../data/invalidation.js";var l=`backlinks.forBlock`,u=async(e,t)=>{if(t.length===0)return new Set;let n=t.map(()=>`?`).join(`, `),r=await e.getAll(`WITH RECURSIVE up(start_id, id, reference_target_id, parent_id, workspace_id, depth) AS (
       SELECT id, id, reference_target_id, parent_id, workspace_id, 0
         FROM blocks WHERE id IN (${n})
       UNION ALL
       SELECT up.start_id, b.id, b.reference_target_id, b.parent_id, b.workspace_id, up.depth + 1
         FROM blocks AS b JOIN up ON b.id = up.parent_id
        WHERE up.depth < 100
     )
     SELECT DISTINCT up.start_id AS id
       FROM up
      WHERE up.reference_target_id IS NOT NULL
        AND up.parent_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM block_types bt
           WHERE bt.block_id = up.reference_target_id
             AND bt.type = 'property-schema'
             AND bt.workspace_id = up.workspace_id
        )`,[...t]);return new Set(r.map(e=>e.id))},d={parse:e=>e},f=e=>{let t=e.where!==void 0&&Object.keys(e.where).length>0,n=e.referencedBy!==void 0,r=e.id!==void 0;return t||n||r},p=e=>(e??[]).filter(f),m=e=>({include:p(e?.include),exclude:p(e?.exclude)}),h=(e,t)=>a(e,t),g=(e,t)=>{let n=m(e),r=m(t);return m({include:[...r.include,...n.include.filter(e=>!r.exclude.some(t=>h(e,t)))],exclude:[...r.exclude,...n.exclude.filter(e=>!r.include.some(t=>h(e,t)))]})},_=e=>{let t=m(e);return t.include.length>0||t.exclude.length>0},v=e({name:l,argsSchema:n({workspaceId:r(),id:r(),filter:i.optional(),rawSources:t().optional()}),resultSchema:d,resolve:async({workspaceId:e,id:t,filter:n,rawSources:r},i)=>{if(!e||!t)return[];i.depend({kind:`plugin`,channel:s,key:c(e,t)});let a=m(n),l=(await i.run(`core.typedBlockIds`,{workspaceId:e,referencedBy:{id:t},match:a.include,exclude:a.exclude,order:`created-desc`})).filter(e=>e!==t);if(r||l.length===0||!await o(i.db,e))return l;let d=await u(i.db,l);return d.size===0?l:l.filter(e=>!d.has(e))}});export{l as BACKLINKS_FOR_BLOCK_QUERY,v as backlinksForBlockQuery,_ as hasBacklinksFilter,g as mergeBacklinksFilters,m as normalizeBacklinksFilter};
//# sourceMappingURL=query.js.map