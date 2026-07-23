import{defineQuery as e}from"../../data/api/query.js";import{boolean as t,object as n,string as r}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{backlinksFilterSchema as i}from"../../data/api/typedBlockQuery.js";import"../../data/api/index.js";import a from"../../../node_modules/.pnpm/lodash-es@4.18.1/node_modules/lodash-es/isEqual.js";import{readIsChildBackedWorkspace as o}from"../../data/workspaceSchema.js";import{TYPED_BLOCKS_STRUCTURE_CHANNEL as s,typedBlocksStructureKey as c}from"../../data/invalidation.js";var l=`backlinks.forBlock`,u=500,d=async(e,t,n=u)=>{let r=new Set;for(let i=0;i<t.length;i+=n){let a=t.slice(i,i+n),o=a.map(()=>`?`).join(`, `),s=await e.getAll(`WITH RECURSIVE up(start_id, id, reference_target_id, parent_id, workspace_id, path, depth) AS (
         SELECT id, id, reference_target_id, parent_id, workspace_id,
                '!' || hex(id) || '/',
                0
           FROM blocks WHERE id IN (${o})
         UNION ALL
         SELECT up.start_id, b.id, b.reference_target_id, b.parent_id, b.workspace_id,
                up.path || '!' || hex(b.id) || '/',
                up.depth + 1
           FROM blocks AS b JOIN up ON b.id = up.parent_id
          WHERE up.depth < 100
            AND INSTR(up.path, '!' || hex(b.id) || '/') = 0
       )
       SELECT DISTINCT up.start_id AS id
         FROM up
        WHERE up.depth > 0
          AND up.reference_target_id IS NOT NULL
          AND up.parent_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM block_types bt
             WHERE bt.block_id = up.reference_target_id
               AND bt.type = 'property-schema'
               AND bt.workspace_id = up.workspace_id
          )`,[...a]);for(let e of s)r.add(e.id)}return r},f={parse:e=>e},p=e=>{let t=e.where!==void 0&&Object.keys(e.where).length>0,n=e.referencedBy!==void 0,r=e.id!==void 0;return t||n||r},m=e=>(e??[]).filter(p),h=e=>({include:m(e?.include),exclude:m(e?.exclude)}),g=(e,t)=>a(e,t),_=(e,t)=>{let n=h(e),r=h(t);return h({include:[...r.include,...n.include.filter(e=>!r.exclude.some(t=>g(e,t)))],exclude:[...r.exclude,...n.exclude.filter(e=>!r.include.some(t=>g(e,t)))]})},v=e=>{let t=h(e);return t.include.length>0||t.exclude.length>0},y=e({name:l,argsSchema:n({workspaceId:r(),id:r(),filter:i.optional(),rawSources:t().optional()}),resultSchema:f,resolve:async({workspaceId:e,id:t,filter:n,rawSources:r},i)=>{if(!e||!t)return[];i.depend({kind:`plugin`,channel:s,key:c(e,t)});let a=h(n),l=(await i.run(`core.typedBlockIds`,{workspaceId:e,referencedBy:{id:t},match:a.include,exclude:a.exclude,order:`created-desc`})).filter(e=>e!==t);if(r||l.length===0||!await o(i.db,e))return l;let u=await d(i.db,l);return u.size===0?l:l.filter(e=>!u.has(e))}});export{l as BACKLINKS_FOR_BLOCK_QUERY,y as backlinksForBlockQuery,v as hasBacklinksFilter,_ as mergeBacklinksFilters,h as normalizeBacklinksFilter,d as propertyMachinerySourceIds};
//# sourceMappingURL=query.js.map