import{defineQuery as e}from"../api/query.js";import{_enum as t,array as n,boolean as r,number as i,object as a,record as o,string as s,unknown as c}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{blockPredicateSchema as l,referenceFilterSchema as u}from"../api/typedBlockQuery.js";import"../api/index.js";import{SELECT_BLOCK_COLUMNS_SQL as d,buildQualifiedBlockColumnsSql as f}from"../blockSchema.js";import{ANCESTORS_SQL as p,CHILDREN_IDS_SQL as m,CHILDREN_SQL as h,SUBTREE_SQL as ee,manyAncestorsSql as te}from"./treeQueries.js";import{assertAncestorWalkBounded as ne,buildCandidatesCte as re,compileTypedBlockQuery as g,isSelectiveWhereValue as _,normalizeTypedBlockQuery as v}from"./typedBlockQuery.js";import{KERNEL_ALIASES_CHANNEL as y,KERNEL_CONTENT_CHANNEL as b,TYPED_BLOCKS_LIVE_CHANNEL as x,TYPED_BLOCKS_PROPERTY_CHANNEL as ie,TYPED_BLOCKS_REFERENCE_CHANNEL as ae,TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL as oe,TYPED_BLOCKS_STRUCTURE_CHANNEL as se,TYPED_BLOCKS_TYPE_CHANNEL as ce,kernelAliasesKey as S,kernelContentKey as le,typedBlocksLiveKey as C,typedBlocksPropertyKey as ue,typedBlocksReferenceFieldKey as de,typedBlocksReferenceKey as fe,typedBlocksStructureKey as w,typedBlocksTypeKey as T}from"../invalidation.js";var pe=`
  SELECT ${d}
  FROM blocks
  WHERE id = ?
    AND deleted = 0
`,E=`
  SELECT ${f(`b`)}
  FROM blocks b
  JOIN block_types bt
    ON bt.block_id = b.id
   AND bt.workspace_id = b.workspace_id
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND bt.type = ?
  ORDER BY b.created_at ASC, b.id ASC
`,me=3,D=e=>`"${e.replace(/"/g,`""`)}"`,O=e=>{let t=e.trim();return t.length>=2&&t.startsWith(`"`)&&t.endsWith(`"`)?t.slice(1,-1):t},he=e=>{let t=[],n=0,r=(e,n)=>{let r=e.trim();if(r){if(!n&&(r===`AND`||r===`OR`||r===`NOT`)){t.push({kind:`operator`,op:r});return}t.push({kind:`term`,text:r,excluded:n})}};for(;n<e.length;){for(;n<e.length&&/\s/.test(e[n]??``);)n++;if(n>=e.length)break;let t=!1;if(e[n]===`-`&&n+1<e.length&&!/\s/.test(e[n+1]??``)&&(t=!0,n++),e[n]===`"`){n++;let i=n;for(;n<e.length&&e[n]!==`"`;)n++;r(e.slice(i,n),t),e[n]===`"`&&n++;continue}let i=n;for(;n<e.length&&!/\s/.test(e[n]??``);)n++;r(e.slice(i,n),t)}return t},k=e=>e.trim().length>=me,A=e=>{let t=O(e.trim());return k(t)?{matchQuery:D(t),rankQuery:t}:null},j=e=>{let t=e.trim();if(!k(t))return null;let n=he(t),r=n.some(e=>e.kind===`term`&&!e.excluded&&k(e.text)),i=O(t),a=[[]],o=[],s=!1,c=!1,l=!1,u=()=>a[a.length-1],d=e=>{s&&u().length>0&&a.push([]),u().push(e),l=!0,s=!1,c=!1},f=e=>k(e)?(d(D(e)),!0):!1;for(let e of n){if(e.kind===`operator`){if(e.op===`OR`){if(l)s=!0;else if(!f(e.op))return A(t);continue}if(e.op===`NOT`){if(l||r)c=!0;else if(!f(e.op))return A(t);continue}if(!l&&!f(e.op))return A(t);continue}if(e.excluded&&!r){if(!f(`-${e.text}`))return A(t);continue}if(c){if(k(e.text))o.push(D(e.text));else return A(t);c=!1,s=!1;continue}if(e.excluded&&r){if(k(e.text))o.push(D(e.text));else return A(t);s=!1;continue}if(!f(e.text))return A(t)}let p=a.filter(e=>e.length>0);if(p.length===0&&k(i))return A(t);if(p.length===0)return null;let m=p.length===1?p[0].join(` `):`(${p.map(e=>e.join(` `)).join(` OR `)})`;return{matchQuery:o.length===0?m:`${m} ${o.map(e=>`NOT ${e}`).join(` `)}`,rankQuery:i}},M=e=>e.replace(/[\\%_]/g,e=>`\\${e}`),N=`
  SELECT ${f(`b`)}
  FROM blocks_fts
  JOIN blocks b
    ON b.id = blocks_fts.block_id
   AND b.workspace_id = blocks_fts.workspace_id
  WHERE blocks_fts.workspace_id = ?
    AND blocks_fts MATCH ?
    AND b.deleted = 0
    AND b.content != ''
  ORDER BY
    CASE
      WHEN LOWER(b.content) = LOWER(?) THEN 0
      WHEN LOWER(b.content) LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END,
    coalesce(b.user_updated_at, b.updated_at) DESC
  LIMIT ?
`,P=`
  SELECT ${d}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
  ORDER BY coalesce(user_updated_at, updated_at) DESC, id ASC
  LIMIT ?
`,F=`
  SELECT ba.alias AS alias
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND b.deleted = 0
    AND (? = '' OR ba.alias_lower LIKE '%' || LOWER(?) || '%' ESCAPE '\\')
  GROUP BY ba.alias
  ORDER BY
    MIN(CASE
      WHEN ba.alias_lower = LOWER(?) THEN 0
      WHEN ba.alias_lower LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END),
    MIN(b.created_at),
    ba.alias
`,I=`
  SELECT ${f(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`,ge=`
  SELECT ${f(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.id != ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`,L=e=>`
    SELECT
      ba.alias AS alias,
      b.id AS blockId,
      b.content AS content,
      coalesce(b.user_updated_at, b.updated_at) AS updatedAt
    FROM block_aliases ba
    JOIN blocks b ON b.id = ba.block_id
    WHERE ba.workspace_id = ?
      AND b.deleted = 0
      AND (${e>0?Array(e).fill(`ba.alias_lower LIKE '%' || ? || '%' ESCAPE '\\'`).join(` AND `):`1=1`})
    ORDER BY
      CASE
        WHEN ba.alias_lower = ? THEN 0
        WHEN ba.alias_lower LIKE ? || '%' ESCAPE '\\' THEN 1
        ELSE 2
      END,
      b.created_at,
      ba.alias
    LIMIT ?
  `,R=`
  SELECT
    ba.alias AS alias,
    b.id AS blockId,
    b.content AS content
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND b.deleted = 0
    AND (? = '' OR ba.alias_lower LIKE '%' || LOWER(?) || '%' ESCAPE '\\')
  ORDER BY
    CASE
      WHEN ba.alias_lower = LOWER(?) THEN 0
      WHEN ba.alias_lower LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END,
    b.created_at,
    ba.alias
  LIMIT ?
`,z=`
  SELECT ${f(`child`)}
  FROM blocks AS child
  WHERE child.parent_id = ?
    AND child.deleted = 0
    AND child.content = ?
  ORDER BY child.order_key, child.id
  LIMIT 1
`,B=e=>e,V={parse:e=>e},_e={parse:e=>e},ve={parse:e=>e},ye={parse:e=>e},H=e({name:`core.subtree`,argsSchema:a({id:s()}),resultSchema:{parse:e=>e},resolve:async({id:e},t)=>{t.depend({kind:`row`,id:e}),t.depend({kind:`parent-edge`,parentId:e});let n=await t.db.getAll(ee,[e]),r=t.hydrateBlocks(B(n)).map((e,t)=>({...e,depth:n[t].depth}));for(let e of r)t.depend({kind:`parent-edge`,parentId:e.id});return r}}),U=e({name:`core.ancestors`,argsSchema:a({id:s()}),resultSchema:V,resolve:async({id:e},t)=>{t.depend({kind:`row`,id:e});let n=await t.db.getAll(p,[e,e]);return t.hydrateBlocks(B(n))}}),W=e({name:`core.manyAncestors`,argsSchema:a({ids:n(s()).readonly()}),resultSchema:{parse:e=>e},resolve:async({ids:e},t)=>{if(e.length===0)return[];for(let n of e)t.depend({kind:`row`,id:n});let n=await t.db.getAll(te(e.length),[...e]),r=new Map;for(let t of e)r.set(t,[]);for(let e of n){let t=r.get(e.chain_start_id);t&&t.push(e)}return e.map(e=>({startId:e,ancestors:t.hydrateBlocks(B(r.get(e)??[]))}))}}),G=e({name:`core.children`,argsSchema:a({id:s()}),resultSchema:V,resolve:async({id:e},t)=>{t.depend({kind:`parent-edge`,parentId:e});let n=await t.db.getAll(h,[e]);return t.hydrateBlocks(B(n))}}),K=e({name:`core.childIds`,argsSchema:a({id:s(),hydrate:r().optional()}),resultSchema:n(s()),resolve:async({id:e,hydrate:t=!1},n)=>{if(n.depend({kind:`parent-edge`,parentId:e}),!t)return(await n.db.getAll(m,[e])).map(e=>e.id);let r=await n.db.getAll(h,[e]);return n.hydrateBlocks(B(r),{declareRowDeps:!1}).map(e=>e.id)}}),be=e({name:`core.byType`,argsSchema:a({workspaceId:s(),type:s()}),resultSchema:V,resolve:async({workspaceId:e,type:t},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:ce,key:T(e,t)});let r=await n.db.getAll(E,[e,t]);return n.hydrateBlocks(B(r))}}),q=a({workspaceId:s(),types:n(s()).optional(),where:o(s(),c()).optional(),referencedBy:u.optional(),match:n(l).optional(),exclude:n(l).optional(),order:t([`created-asc`,`created-desc`]).optional()}),xe=e=>`
  WITH RECURSIVE
    ${e},
    walk(anc_id, anc_parent_id, depth, path) AS (
      SELECT seed.id, seed.parent_id, 0, '!' || hex(seed.id) || '/'
      FROM candidates c
      JOIN blocks seed ON seed.id = c.id
      WHERE seed.deleted = 0
      UNION ALL
      SELECT
        parent.id,
        parent.parent_id,
        walk.depth + 1,
        walk.path || '!' || hex(parent.id) || '/'
      FROM walk
      JOIN blocks parent ON parent.id = walk.anc_parent_id
      WHERE parent.deleted = 0
        AND walk.depth < 100
        AND INSTR(walk.path, '!' || hex(parent.id) || '/') = 0
    )
  SELECT DISTINCT anc_id FROM walk
`,J=(e,t,n)=>{if(e!==void 0)for(let[r,i]of Object.entries(e)){if(n.depend({kind:`plugin`,channel:ie,key:ue(t,r)}),typeof i!=`object`||!i||i instanceof Date||Array.isArray(i))continue;let e=Object.entries(i);if(e.length!==1)continue;let[a,o]=e[0];if(a!==`target`||typeof o!=`object`||!o||Array.isArray(o))continue;let s=o;Object.values(s).some(_)||n.depend({kind:`plugin`,channel:x,key:C(t)}),J(s,t,n)}},Se=(e,t,n,r={})=>{if(e.sourceField!==void 0){n.depend({kind:`plugin`,channel:oe,key:de(t,e.id,e.sourceField)});return}n.depend({kind:`plugin`,channel:ae,key:fe(t,e.id)}),r.includeImplicitAncestorStructure&&n.depend({kind:`plugin`,channel:se,key:w(t,e.id)})},Ce=(e,t,n)=>{for(let r of e)J(r.where,t,n),r.referencedBy!==void 0&&Se(r.referencedBy,t,n,{includeImplicitAncestorStructure:r.scope===`ancestor`})},Y=(e,t)=>{let n=e.workspaceId,r=e.types??[],i=e.referencedBy,a=e.match??[],o=e.exclude??[];for(let e of r)t.depend({kind:`plugin`,channel:ce,key:T(n,e)});J(e.where,n,t),i!==void 0&&Se(i,n,t),Ce(a,n,t),Ce(o,n,t);let s=Object.values(e.where??{}).some(_),c=a.some(e=>e.referencedBy!==void 0||e.where!==void 0&&Object.values(e.where).some(_));return r.length>0||i!==void 0||s||c||t.depend({kind:`plugin`,channel:x,key:C(n)}),{workspaceId:n,types:r,referencedBy:i,matchPredicates:a,excludePredicates:o}},X=(e,t)=>e.some(e=>e.scope===`ancestor`)||t.some(e=>e.scope===`ancestor`),Z=async(e,t,n)=>{ne(e);let r=re(e,t.repo.propertySchemas),i=await t.db.getAll(xe(r.sql),r.params);for(let r of i)n===`row`?t.depend({kind:`row`,id:r.anc_id}):t.depend({kind:`plugin`,channel:se,key:w(e.workspaceId,r.anc_id)})},we=async(e,t)=>{if(!e.workspaceId)return[];let n=v(e),{workspaceId:r,types:i,referencedBy:a,matchPredicates:o,excludePredicates:s}=Y(n,t);if(X(o,s)&&await Z(n,t,`row`),i.length===1&&n.where===void 0&&a===void 0&&o.length===0&&s.length===0&&n.order!==`created-desc`){let e=await t.db.getAll(E,[r,i[0]]);return t.hydrateBlocks(B(e))}let c=g(n,t.repo.propertySchemas),l=await t.db.getAll(c.sql,[...c.params]);return t.hydrateBlocks(B(l))},Te=async(e,t)=>{if(!e.workspaceId)return[];let n=v(e),{matchPredicates:r,excludePredicates:i}=Y(n,t);X(r,i)&&await Z(n,t,`structure`);let a=g(n,t.repo.propertySchemas,{projection:`ids`});return(await t.db.getAll(a.sql,[...a.params])).map(e=>e.id)},Ee=e({name:`core.typedBlocks`,argsSchema:q,resultSchema:V,resolve:(e,t)=>we(e,t)}),De=e({name:`core.typedBlockIds`,argsSchema:q,resultSchema:_e,resolve:(e,t)=>Te(e,t)}),Oe=async(e,t)=>{if(!e.workspaceId)return 0;let n=v(e),{matchPredicates:r,excludePredicates:i}=Y(n,t);X(r,i)&&await Z(n,t,`structure`);let a=g(n,t.repo.propertySchemas,{projection:`count`});return(await t.db.get(a.sql,[...a.params]))?.count??0},Q=e({name:`core.typedBlockCount`,argsSchema:q,resultSchema:ve,resolve:(e,t)=>Oe(e,t)}),ke=e({name:`core.searchByContent`,argsSchema:a({workspaceId:s(),query:s(),limit:i().optional()}),resultSchema:V,resolve:async({workspaceId:e,query:t,limit:n=50},r)=>{let i=j(t);if(i===null)return[];r.depend({kind:`plugin`,channel:b,key:le(e)});let a=await r.db.getAll(N,[e,i.matchQuery,i.rankQuery,M(i.rankQuery),n]);return r.hydrateBlocks(B(a),{declareRowDeps:!1})}}),Ae=e({name:`core.recentBlocks`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:V,resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:b,key:le(e)});let r=await n.db.getAll(P,[e,t]);return n.hydrateBlocks(B(r),{declareRowDeps:!1})}}),je=e({name:`core.firstChildByContent`,argsSchema:a({parentId:s(),content:s()}),resultSchema:ye,resolve:async({parentId:e,content:t},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=await n.db.getAll(m,[e]);for(let e of r)n.depend({kind:`row`,id:e.id});let i=await n.db.getOptional(z,[e,t]);return i===null?null:n.hydrateBlocks(B([i]),{declareRowDeps:!1})[0]??null}}),Me=e({name:`core.aliasesInWorkspace`,argsSchema:a({workspaceId:s(),filter:s().optional()}),resultSchema:n(s()),resolve:async({workspaceId:e,filter:t=``},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:y,key:S(e)});let r=M(t);return(await n.db.getAll(F,[e,t,r,t,r])).map(e=>e.alias)}}),Ne=e({name:`core.aliasMatches`,argsSchema:a({workspaceId:s(),filter:s(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s()})),resolve:async({workspaceId:e,filter:t,limit:n=50},r)=>{if(!e)return[];r.depend({kind:`plugin`,channel:y,key:S(e)});let i=M(t),a=await r.db.getAll(R,[e,t,i,t,i,n]);for(let e of a)r.depend({kind:`row`,id:e.blockId});return a}}),Pe=e({name:`core.aliasMatchesFuzzy`,argsSchema:a({workspaceId:s(),prefixes:n(s()),query:s().optional(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s(),updatedAt:i()})),resolve:async({workspaceId:e,prefixes:t,query:n=``,limit:r=100},i)=>{if(!e)return[];i.depend({kind:`plugin`,channel:y,key:S(e)});let a=L(t.length),o=n.toLowerCase(),s=[e,...t.map(M),o,M(o),r],c=await i.db.getAll(a,s);for(let e of c)i.depend({kind:`row`,id:e.blockId});return c}}),Fe=e({name:`core.aliasLookup`,argsSchema:a({workspaceId:s(),alias:s()}),resultSchema:ye,resolve:async({workspaceId:e,alias:t},n)=>{if(!e||!t)return null;n.depend({kind:`plugin`,channel:y,key:S(e)});let r=await n.db.getOptional(I,[e,t]);return r===null?null:n.hydrateBlocks(B([r]))[0]??null}}),$=e({name:`core.findExtensionBlocks`,argsSchema:a({workspaceId:s()}),resultSchema:V,resolve:async({workspaceId:e},t)=>{if(!e)return[];let n=await t.db.getAll(E,[e,`extension`]);return t.hydrateBlocks(B(n))}}),Ie=[H,U,W,G,K,be,Ee,De,Q,ke,Ae,je,Me,Ne,Pe,Fe,$];export{Ie as KERNEL_QUERIES,F as SELECT_ALIASES_IN_WORKSPACE_SQL,R as SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,N as SELECT_BLOCKS_BY_CONTENT_SQL,E as SELECT_BLOCKS_BY_TYPE_SQL,ge as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,I as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,pe as SELECT_BLOCK_BY_ID_SQL,z as SELECT_FIRST_CHILD_BY_CONTENT_SQL,P as SELECT_RECENT_BLOCKS_SQL,Fe as aliasLookupQuery,Pe as aliasMatchesFuzzyQuery,Ne as aliasMatchesQuery,Me as aliasesInWorkspaceQuery,U as ancestorsQuery,L as buildFuzzyAliasMatchesSql,be as byTypeQuery,K as childIdsQuery,G as childrenQuery,j as compileBlocksContentSearchQuery,$ as findExtensionBlocksQuery,je as firstChildByContentQuery,W as manyAncestorsQuery,Ae as recentBlocksQuery,Oe as resolveTypedBlockCount,Te as resolveTypedBlockIds,we as resolveTypedBlocks,ke as searchByContentQuery,H as subtreeQuery,Q as typedBlockCountQuery,De as typedBlockIdsQuery,Ee as typedBlocksQuery};
//# sourceMappingURL=kernelQueries.js.map