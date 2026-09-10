import{defineQuery as e}from"../../data/api/query.js";import{boolean as t,object as n,string as r}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{backlinksFilterSchema as i}from"../../data/api/typedBlockQuery.js";import"../../data/api/index.js";import a from"../../../node_modules/.pnpm/lodash-es@4.18.1/node_modules/lodash-es/isEqual.js";import{recognizedFieldRowSql as o}from"../../data/internals/treeQueries.js";import{TYPED_BLOCKS_STRUCTURE_CHANNEL as s,typedBlocksStructureKey as c}from"../../data/invalidation.js";import{registrySeedParams as l}from"../../data/internals/kernelQueries.js";var u=`backlinks.forBlock`,d=500,f=async(e,t)=>await e.getOptional(`SELECT 1 AS one FROM blocks
    WHERE workspace_id = ? AND is_field_form = 1 LIMIT 1`,[t])!==null,p=async(e,t,n,r=d)=>{let i=new Set;for(let a=0;a<t.length;a+=r){let s=t.slice(a,a+r),c=s.map(()=>`?`).join(`, `),l=await e.getAll(`WITH RECURSIVE up(start_id, id, reference_target_id, is_field_form, parent_id, workspace_id, path, depth) AS (
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
          AND (${o(`up`)})`,[...s,...n]);for(let e of l)i.add(e.id)}return i},m={parse:e=>e},h=e=>{let t=e.where!==void 0&&Object.keys(e.where).length>0,n=e.referencedBy!==void 0,r=e.id!==void 0;return t||n||r},g=e=>(e??[]).filter(h),_=e=>({include:g(e?.include),exclude:g(e?.exclude)}),v=(e,t)=>a(e,t),y=(e,t)=>{let n=_(e),r=_(t);return _({include:[...r.include,...n.include.filter(e=>!r.exclude.some(t=>v(e,t)))],exclude:[...r.exclude,...n.exclude.filter(e=>!r.include.some(t=>v(e,t)))]})},b=e=>{let t=_(e);return t.include.length>0||t.exclude.length>0},x=e({name:u,argsSchema:n({workspaceId:r(),id:r(),filter:i.optional(),rawSources:t().optional()}),resultSchema:m,resolve:async({workspaceId:e,id:t,filter:n,rawSources:r},i)=>{if(!e||!t)return[];i.depend({kind:`plugin`,channel:s,key:c(e,t)});let a=_(n),o=(await i.run(`core.typedBlockIds`,{workspaceId:e,referencedBy:{id:t},match:a.include,exclude:a.exclude,order:`created-desc`})).filter(e=>e!==t);if(r||o.length===0||!await f(i.db,e))return o;let u=await p(i.db,o,l(i.repo));return u.size===0?o:o.filter(e=>!u.has(e))}});export{u as BACKLINKS_FOR_BLOCK_QUERY,x as backlinksForBlockQuery,b as hasBacklinksFilter,y as mergeBacklinksFilters,_ as normalizeBacklinksFilter,p as propertyMachinerySourceIds,f as workspaceHasPropertyMachinery};
//# sourceMappingURL=query.js.map