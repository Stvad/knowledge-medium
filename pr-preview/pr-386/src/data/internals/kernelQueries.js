import{defineQuery as e}from"../api/query.js";import{_enum as t,array as n,boolean as r,number as i,object as a,record as o,string as s,unknown as c}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{blockPredicateSchema as l,referenceFilterSchema as u}from"../api/typedBlockQuery.js";import"../api/index.js";import{SELECT_BLOCK_COLUMNS_SQL as d,buildQualifiedBlockColumnsSql as f}from"../blockSchema.js";import{ANCESTORS_SQL as p,CHILDREN_IDS_SQL as m,CHILDREN_SQL as h,SUBTREE_SQL as ee,VISIBLE_CHILDREN_IDS_SQL as te,VISIBLE_CHILDREN_SQL as ne,VISIBLE_SUBTREE_SQL as re,manyAncestorsSql as ie}from"./treeQueries.js";import{assertAncestorWalkBounded as ae,buildCandidatesCte as oe,compileTypedBlockQuery as g,isSelectiveWhereValue as _,normalizeTypedBlockQuery as v}from"./typedBlockQuery.js";import{KERNEL_ALIASES_CHANNEL as y,KERNEL_CONTENT_CHANNEL as b,TYPED_BLOCKS_LIVE_CHANNEL as x,TYPED_BLOCKS_PROPERTY_CHANNEL as se,TYPED_BLOCKS_REFERENCE_CHANNEL as ce,TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL as le,TYPED_BLOCKS_STRUCTURE_CHANNEL as ue,TYPED_BLOCKS_TYPE_CHANNEL as de,kernelAliasesKey as S,kernelContentKey as C,typedBlocksLiveKey as w,typedBlocksPropertyKey as fe,typedBlocksReferenceFieldKey as pe,typedBlocksReferenceKey as me,typedBlocksStructureKey as T,typedBlocksTypeKey as E}from"../invalidation.js";var he=`
  SELECT ${d}
  FROM blocks
  WHERE id = ?
    AND deleted = 0
`,D=`
  SELECT ${f(`b`)}
  FROM blocks b
  JOIN block_types bt
    ON bt.block_id = b.id
   AND bt.workspace_id = b.workspace_id
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND bt.type = ?
  ORDER BY b.created_at ASC, b.id ASC
`,ge=3,O=e=>`"${e.replace(/"/g,`""`)}"`,k=e=>{let t=e.trim();return t.length>=2&&t.startsWith(`"`)&&t.endsWith(`"`)?t.slice(1,-1):t},_e=e=>{let t=[],n=0,r=(e,n)=>{let r=e.trim();if(r){if(!n&&(r===`AND`||r===`OR`||r===`NOT`)){t.push({kind:`operator`,op:r});return}t.push({kind:`term`,text:r,excluded:n})}};for(;n<e.length;){for(;n<e.length&&/\s/.test(e[n]??``);)n++;if(n>=e.length)break;let t=!1;if(e[n]===`-`&&n+1<e.length&&!/\s/.test(e[n+1]??``)&&(t=!0,n++),e[n]===`"`){n++;let i=n;for(;n<e.length&&e[n]!==`"`;)n++;r(e.slice(i,n),t),e[n]===`"`&&n++;continue}let i=n;for(;n<e.length&&!/\s/.test(e[n]??``);)n++;r(e.slice(i,n),t)}return t},A=e=>e.trim().length>=ge,j=e=>{let t=k(e.trim());return A(t)?{matchQuery:O(t),rankQuery:t}:null},M=e=>{let t=e.trim();if(!A(t))return null;let n=_e(t),r=n.some(e=>e.kind===`term`&&!e.excluded&&A(e.text)),i=k(t),a=[[]],o=[],s=!1,c=!1,l=!1,u=()=>a[a.length-1],d=e=>{s&&u().length>0&&a.push([]),u().push(e),l=!0,s=!1,c=!1},f=e=>A(e)?(d(O(e)),!0):!1;for(let e of n){if(e.kind===`operator`){if(e.op===`OR`){if(l)s=!0;else if(!f(e.op))return j(t);continue}if(e.op===`NOT`){if(l||r)c=!0;else if(!f(e.op))return j(t);continue}if(!l&&!f(e.op))return j(t);continue}if(e.excluded&&!r){if(!f(`-${e.text}`))return j(t);continue}if(c){if(A(e.text))o.push(O(e.text));else return j(t);c=!1,s=!1;continue}if(e.excluded&&r){if(A(e.text))o.push(O(e.text));else return j(t);s=!1;continue}if(!f(e.text))return j(t)}let p=a.filter(e=>e.length>0);if(p.length===0&&A(i))return j(t);if(p.length===0)return null;let m=p.length===1?p[0].join(` `):`(${p.map(e=>e.join(` `)).join(` OR `)})`;return{matchQuery:o.length===0?m:`${m} ${o.map(e=>`NOT ${e}`).join(` `)}`,rankQuery:i}},N=e=>e.replace(/[\\%_]/g,e=>`\\${e}`),P=`
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
`,F=`
  SELECT ${d}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
  ORDER BY coalesce(user_updated_at, updated_at) DESC, id ASC
  LIMIT ?
`,I=`
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
`,L=`
  SELECT ${f(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`,ve=`
  SELECT ${f(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.id != ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`,R=e=>`
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
  `,z=`
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
`,B=`
  SELECT ${f(`child`)}
  FROM blocks AS child
  WHERE child.parent_id = ?
    AND child.deleted = 0
    AND child.content = ?
  ORDER BY child.order_key, child.id
  LIMIT 1
`,V=e=>e,H={parse:e=>e},ye={parse:e=>e},be={parse:e=>e},U={parse:e=>e},W=e({name:`core.subtree`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:{parse:e=>e},resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`row`,id:e}),n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(re,[e,e]):await n.db.getAll(ee,[e]),i=n.hydrateBlocks(V(r)).map((e,t)=>({...e,depth:r[t].depth}));for(let e of i)n.depend({kind:`parent-edge`,parentId:e.id});return i}}),G=e({name:`core.ancestors`,argsSchema:a({id:s()}),resultSchema:H,resolve:async({id:e},t)=>{t.depend({kind:`row`,id:e});let n=await t.db.getAll(p,[e,e]);return t.hydrateBlocks(V(n))}}),K=e({name:`core.manyAncestors`,argsSchema:a({ids:n(s()).readonly()}),resultSchema:{parse:e=>e},resolve:async({ids:e},t)=>{if(e.length===0)return[];for(let n of e)t.depend({kind:`row`,id:n});let n=await t.db.getAll(ie(e.length),[...e]),r=new Map;for(let t of e)r.set(t,[]);for(let e of n){let t=r.get(e.chain_start_id);t&&t.push(e)}return e.map(e=>({startId:e,ancestors:t.hydrateBlocks(V(r.get(e)??[]))}))}}),q=e({name:`core.children`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:H,resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(ne,[e,e]):await n.db.getAll(h,[e]);return n.hydrateBlocks(V(r))}}),xe=e({name:`core.childIds`,argsSchema:a({id:s(),hydrate:r().optional(),hidePropertyChildren:r().optional()}),resultSchema:n(s()),resolve:async({id:e,hydrate:t=!1,hidePropertyChildren:n=!1},r)=>{if(r.depend({kind:`parent-edge`,parentId:e}),!t)return(n?await r.db.getAll(te,[e,e]):await r.db.getAll(m,[e])).map(e=>e.id);let i=n?await r.db.getAll(ne,[e,e]):await r.db.getAll(h,[e]);return r.hydrateBlocks(V(i),{declareRowDeps:!1}).map(e=>e.id)}}),Se=e({name:`core.byType`,argsSchema:a({workspaceId:s(),type:s()}),resultSchema:H,resolve:async({workspaceId:e,type:t},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:de,key:E(e,t)});let r=await n.db.getAll(D,[e,t]);return n.hydrateBlocks(V(r))}}),J=a({workspaceId:s(),types:n(s()).optional(),where:o(s(),c()).optional(),referencedBy:u.optional(),match:n(l).optional(),exclude:n(l).optional(),order:t([`created-asc`,`created-desc`]).optional()}),Ce=e=>`
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
`,Y=(e,t,n)=>{if(e!==void 0)for(let[r,i]of Object.entries(e)){if(n.depend({kind:`plugin`,channel:se,key:fe(t,r)}),typeof i!=`object`||!i||i instanceof Date||Array.isArray(i))continue;let e=Object.entries(i);if(e.length!==1)continue;let[a,o]=e[0];if(a!==`target`||typeof o!=`object`||!o||Array.isArray(o))continue;let s=o;Object.values(s).some(_)||n.depend({kind:`plugin`,channel:x,key:w(t)}),Y(s,t,n)}},we=(e,t,n,r={})=>{if(e.sourceField!==void 0){n.depend({kind:`plugin`,channel:le,key:pe(t,e.id,e.sourceField)});return}n.depend({kind:`plugin`,channel:ce,key:me(t,e.id)}),r.includeImplicitAncestorStructure&&n.depend({kind:`plugin`,channel:ue,key:T(t,e.id)})},Te=(e,t,n)=>{for(let r of e)Y(r.where,t,n),r.referencedBy!==void 0&&we(r.referencedBy,t,n,{includeImplicitAncestorStructure:r.scope===`ancestor`})},X=(e,t)=>{let n=e.workspaceId,r=e.types??[],i=e.referencedBy,a=e.match??[],o=e.exclude??[];for(let e of r)t.depend({kind:`plugin`,channel:de,key:E(n,e)});Y(e.where,n,t),i!==void 0&&we(i,n,t),Te(a,n,t),Te(o,n,t);let s=Object.values(e.where??{}).some(_),c=a.some(e=>e.referencedBy!==void 0||e.where!==void 0&&Object.values(e.where).some(_));return r.length>0||i!==void 0||s||c||t.depend({kind:`plugin`,channel:x,key:w(n)}),{workspaceId:n,types:r,referencedBy:i,matchPredicates:a,excludePredicates:o}},Z=(e,t)=>e.some(e=>e.scope===`ancestor`)||t.some(e=>e.scope===`ancestor`),Q=async(e,t,n)=>{ae(e);let r=oe(e,t.repo.propertySchemas),i=await t.db.getAll(Ce(r.sql),r.params);for(let r of i)n===`row`?t.depend({kind:`row`,id:r.anc_id}):t.depend({kind:`plugin`,channel:ue,key:T(e.workspaceId,r.anc_id)})},Ee=async(e,t)=>{if(!e.workspaceId)return[];let n=v(e),{workspaceId:r,types:i,referencedBy:a,matchPredicates:o,excludePredicates:s}=X(n,t);if(Z(o,s)&&await Q(n,t,`row`),i.length===1&&n.where===void 0&&a===void 0&&o.length===0&&s.length===0&&n.order!==`created-desc`){let e=await t.db.getAll(D,[r,i[0]]);return t.hydrateBlocks(V(e))}let c=g(n,t.repo.propertySchemas),l=await t.db.getAll(c.sql,[...c.params]);return t.hydrateBlocks(V(l))},De=async(e,t)=>{if(!e.workspaceId)return[];let n=v(e),{matchPredicates:r,excludePredicates:i}=X(n,t);Z(r,i)&&await Q(n,t,`structure`);let a=g(n,t.repo.propertySchemas,{projection:`ids`});return(await t.db.getAll(a.sql,[...a.params])).map(e=>e.id)},Oe=e({name:`core.typedBlocks`,argsSchema:J,resultSchema:H,resolve:(e,t)=>Ee(e,t)}),ke=e({name:`core.typedBlockIds`,argsSchema:J,resultSchema:ye,resolve:(e,t)=>De(e,t)}),Ae=async(e,t)=>{if(!e.workspaceId)return 0;let n=v(e),{matchPredicates:r,excludePredicates:i}=X(n,t);Z(r,i)&&await Q(n,t,`structure`);let a=g(n,t.repo.propertySchemas,{projection:`count`});return(await t.db.get(a.sql,[...a.params]))?.count??0},je=e({name:`core.typedBlockCount`,argsSchema:J,resultSchema:be,resolve:(e,t)=>Ae(e,t)}),Me=e({name:`core.searchByContent`,argsSchema:a({workspaceId:s(),query:s(),limit:i().optional()}),resultSchema:H,resolve:async({workspaceId:e,query:t,limit:n=50},r)=>{let i=M(t);if(i===null)return[];r.depend({kind:`plugin`,channel:b,key:C(e)});let a=await r.db.getAll(P,[e,i.matchQuery,i.rankQuery,N(i.rankQuery),n]);return r.hydrateBlocks(V(a),{declareRowDeps:!1})}}),Ne=e({name:`core.recentBlocks`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:H,resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:b,key:C(e)});let r=await n.db.getAll(F,[e,t]);return n.hydrateBlocks(V(r),{declareRowDeps:!1})}}),Pe=e({name:`core.firstChildByContent`,argsSchema:a({parentId:s(),content:s()}),resultSchema:U,resolve:async({parentId:e,content:t},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=await n.db.getAll(m,[e]);for(let e of r)n.depend({kind:`row`,id:e.id});let i=await n.db.getOptional(B,[e,t]);return i===null?null:n.hydrateBlocks(V([i]),{declareRowDeps:!1})[0]??null}}),Fe=e({name:`core.aliasesInWorkspace`,argsSchema:a({workspaceId:s(),filter:s().optional()}),resultSchema:n(s()),resolve:async({workspaceId:e,filter:t=``},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:y,key:S(e)});let r=N(t);return(await n.db.getAll(I,[e,t,r,t,r])).map(e=>e.alias)}}),Ie=e({name:`core.aliasMatches`,argsSchema:a({workspaceId:s(),filter:s(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s()})),resolve:async({workspaceId:e,filter:t,limit:n=50},r)=>{if(!e)return[];r.depend({kind:`plugin`,channel:y,key:S(e)});let i=N(t),a=await r.db.getAll(z,[e,t,i,t,i,n]);for(let e of a)r.depend({kind:`row`,id:e.blockId});return a}}),Le=e({name:`core.aliasMatchesFuzzy`,argsSchema:a({workspaceId:s(),prefixes:n(s()),query:s().optional(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s(),updatedAt:i()})),resolve:async({workspaceId:e,prefixes:t,query:n=``,limit:r=100},i)=>{if(!e)return[];i.depend({kind:`plugin`,channel:y,key:S(e)});let a=R(t.length),o=n.toLowerCase(),s=[e,...t.map(N),o,N(o),r],c=await i.db.getAll(a,s);for(let e of c)i.depend({kind:`row`,id:e.blockId});return c}}),Re=e({name:`core.aliasLookup`,argsSchema:a({workspaceId:s(),alias:s()}),resultSchema:U,resolve:async({workspaceId:e,alias:t},n)=>{if(!e||!t)return null;n.depend({kind:`plugin`,channel:y,key:S(e)});let r=await n.db.getOptional(L,[e,t]);return r===null?null:n.hydrateBlocks(V([r]))[0]??null}}),$=e({name:`core.findExtensionBlocks`,argsSchema:a({workspaceId:s()}),resultSchema:H,resolve:async({workspaceId:e},t)=>{if(!e)return[];let n=await t.db.getAll(D,[e,`extension`]);return t.hydrateBlocks(V(n))}}),ze=[W,G,K,q,xe,Se,Oe,ke,je,Me,Ne,Pe,Fe,Ie,Le,Re,$];export{ze as KERNEL_QUERIES,I as SELECT_ALIASES_IN_WORKSPACE_SQL,z as SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,P as SELECT_BLOCKS_BY_CONTENT_SQL,D as SELECT_BLOCKS_BY_TYPE_SQL,ve as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,L as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,he as SELECT_BLOCK_BY_ID_SQL,B as SELECT_FIRST_CHILD_BY_CONTENT_SQL,F as SELECT_RECENT_BLOCKS_SQL,Re as aliasLookupQuery,Le as aliasMatchesFuzzyQuery,Ie as aliasMatchesQuery,Fe as aliasesInWorkspaceQuery,G as ancestorsQuery,R as buildFuzzyAliasMatchesSql,Se as byTypeQuery,xe as childIdsQuery,q as childrenQuery,M as compileBlocksContentSearchQuery,$ as findExtensionBlocksQuery,Pe as firstChildByContentQuery,K as manyAncestorsQuery,Ne as recentBlocksQuery,Ae as resolveTypedBlockCount,De as resolveTypedBlockIds,Ee as resolveTypedBlocks,Me as searchByContentQuery,W as subtreeQuery,je as typedBlockCountQuery,ke as typedBlockIdsQuery,Oe as typedBlocksQuery};
//# sourceMappingURL=kernelQueries.js.map