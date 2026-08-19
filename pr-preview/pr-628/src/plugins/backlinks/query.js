import{defineQuery as e}from"../../data/api/query.js";import{boolean as t,object as n,string as r}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{backlinksFilterSchema as i}from"../../data/api/typedBlockQuery.js";import"../../data/api/index.js";import a from"../../../node_modules/.pnpm/lodash-es@4.18.1/node_modules/lodash-es/isEqual.js";import{recognizedFieldRowSql as o}from"../../data/internals/treeQueries.js";import{TYPED_BLOCKS_STRUCTURE_CHANNEL as s,typedBlocksStructureKey as c}from"../../data/invalidation.js";import{registrySeedParams as l}from"../../data/internals/kernelQueries.js";var u=`backlinks.forBlock`,d=500,f=async(e,t,n=[`[]`,``],r=d)=>{let i=new Set;for(let a=0;a<t.length;a+=r){let s=t.slice(a,a+r),c=s.map(()=>`?`).join(`, `),l=await e.getAll(`WITH RECURSIVE up(start_id, id, reference_target_id, is_field_form, parent_id, workspace_id, path, depth) AS (
         SELECT id, id, reference_target_id, is_field_form, parent_id, workspace_id,
                '!' || hex(id) || '/',
                0
           FROM blocks WHERE id IN (${c})
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
          AND (${o(`up`)})`,[...s,...n]);for(let e of l)i.add(e.id)}return i},p={parse:e=>e},m=e=>{let t=e.where!==void 0&&Object.keys(e.where).length>0,n=e.referencedBy!==void 0,r=e.id!==void 0;return t||n||r},h=e=>(e??[]).filter(m),g=e=>({include:h(e?.include),exclude:h(e?.exclude)}),_=(e,t)=>a(e,t),v=(e,t)=>{let n=g(e),r=g(t);return g({include:[...r.include,...n.include.filter(e=>!r.exclude.some(t=>_(e,t)))],exclude:[...r.exclude,...n.exclude.filter(e=>!r.include.some(t=>_(e,t)))]})},y=e=>{let t=g(e);return t.include.length>0||t.exclude.length>0},b=e({name:u,argsSchema:n({workspaceId:r(),id:r(),filter:i.optional(),rawSources:t().optional()}),resultSchema:p,resolve:async({workspaceId:e,id:t,filter:n,rawSources:r},i)=>{if(!e||!t)return[];i.depend({kind:`plugin`,channel:s,key:c(e,t)});let a=g(n),o=(await i.run(`core.typedBlockIds`,{workspaceId:e,referencedBy:{id:t},match:a.include,exclude:a.exclude,order:`created-desc`})).filter(e=>e!==t);if(r||o.length===0)return o;let u=await f(i.db,o,l(i.repo));return u.size===0?o:o.filter(e=>!u.has(e))}});export{u as BACKLINKS_FOR_BLOCK_QUERY,b as backlinksForBlockQuery,y as hasBacklinksFilter,v as mergeBacklinksFilters,g as normalizeBacklinksFilter,f as propertyMachinerySourceIds};
//# sourceMappingURL=query.js.map