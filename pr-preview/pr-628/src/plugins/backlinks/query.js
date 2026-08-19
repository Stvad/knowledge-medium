import{defineQuery as e}from"../../data/api/query.js";import{boolean as t,object as n,string as r}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{backlinksFilterSchema as i}from"../../data/api/typedBlockQuery.js";import"../../data/api/index.js";import a from"../../../node_modules/.pnpm/lodash-es@4.18.1/node_modules/lodash-es/isEqual.js";import{TYPED_BLOCKS_STRUCTURE_CHANNEL as o,typedBlocksStructureKey as s}from"../../data/invalidation.js";var c=`backlinks.forBlock`,l=500,u=async(e,t,n=l)=>{let r=new Set;for(let i=0;i<t.length;i+=n){let a=t.slice(i,i+n),o=a.map(()=>`?`).join(`, `),s=await e.getAll(`WITH RECURSIVE up(start_id, id, reference_target_id, is_field_form, parent_id, workspace_id, path, depth) AS (
         SELECT id, id, reference_target_id, is_field_form, parent_id, workspace_id,
                '!' || hex(id) || '/',
                0
           FROM blocks WHERE id IN (${o})
         UNION ALL
         SELECT up.start_id, b.id, b.reference_target_id, b.is_field_form, b.parent_id, b.workspace_id,
                up.path || '!' || hex(b.id) || '/',
                up.depth + 1
           FROM blocks AS b JOIN up ON b.id = up.parent_id
          WHERE up.depth < 100
            AND INSTR(up.path, '!' || hex(b.id) || '/') = 0
       )
       SELECT DISTINCT up.start_id AS id
         FROM up
        WHERE up.depth > 0
          AND COALESCE(up.is_field_form, 0) = 1
          AND up.reference_target_id IS NOT NULL
          AND up.parent_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM block_types bt
             WHERE bt.block_id = up.reference_target_id
               AND bt.type = 'property-schema'
               AND bt.workspace_id = up.workspace_id
          )`,[...a]);for(let e of s)r.add(e.id)}return r},d={parse:e=>e},f=e=>{let t=e.where!==void 0&&Object.keys(e.where).length>0,n=e.referencedBy!==void 0,r=e.id!==void 0;return t||n||r},p=e=>(e??[]).filter(f),m=e=>({include:p(e?.include),exclude:p(e?.exclude)}),h=(e,t)=>a(e,t),g=(e,t)=>{let n=m(e),r=m(t);return m({include:[...r.include,...n.include.filter(e=>!r.exclude.some(t=>h(e,t)))],exclude:[...r.exclude,...n.exclude.filter(e=>!r.include.some(t=>h(e,t)))]})},_=e=>{let t=m(e);return t.include.length>0||t.exclude.length>0},v=e({name:c,argsSchema:n({workspaceId:r(),id:r(),filter:i.optional(),rawSources:t().optional()}),resultSchema:d,resolve:async({workspaceId:e,id:t,filter:n,rawSources:r},i)=>{if(!e||!t)return[];i.depend({kind:`plugin`,channel:o,key:s(e,t)});let a=m(n),c=(await i.run(`core.typedBlockIds`,{workspaceId:e,referencedBy:{id:t},match:a.include,exclude:a.exclude,order:`created-desc`})).filter(e=>e!==t);if(r||c.length===0)return c;let l=await u(i.db,c);return l.size===0?c:c.filter(e=>!l.has(e))}});export{c as BACKLINKS_FOR_BLOCK_QUERY,v as backlinksForBlockQuery,_ as hasBacklinksFilter,g as mergeBacklinksFilters,m as normalizeBacklinksFilter,u as propertyMachinerySourceIds};
//# sourceMappingURL=query.js.map