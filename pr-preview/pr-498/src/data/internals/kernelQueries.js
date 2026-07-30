import{defineQuery as e}from"../api/query.js";import{_enum as t,array as n,boolean as r,number as i,object as a,record as o,string as s,unknown as c}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{blockPredicateSchema as l,referenceFilterSchema as u}from"../api/typedBlockQuery.js";import"../api/index.js";import{SELECT_BLOCK_COLUMNS_SQL as d,buildQualifiedBlockColumnsSql as f}from"../blockSchema.js";import{ANCESTORS_SQL as p,CHILDREN_IDS_SQL as m,CHILDREN_SQL as h,SUBTREE_SQL as ee,VISIBLE_CHILDREN_IDS_SQL as te,VISIBLE_CHILDREN_SQL as g,VISIBLE_SUBTREE_SQL as ne,manyAncestorsSql as re}from"./treeQueries.js";import{assertAncestorWalkBounded as ie,buildCandidatesCte as ae,compileTypedBlockQuery as _,isSelectiveWhereValue as v,normalizeTypedBlockQuery as y}from"./typedBlockQuery.js";import{KERNEL_ALIASES_CHANNEL as b,KERNEL_CONTENT_CHANNEL as oe,TYPED_BLOCKS_LIVE_CHANNEL as se,TYPED_BLOCKS_PROPERTY_CHANNEL as ce,TYPED_BLOCKS_REFERENCE_CHANNEL as le,TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL as ue,TYPED_BLOCKS_STRUCTURE_CHANNEL as de,TYPED_BLOCKS_TYPE_CHANNEL as fe,kernelAliasesKey as x,kernelContentKey as S,typedBlocksLiveKey as C,typedBlocksPropertyKey as pe,typedBlocksReferenceFieldKey as me,typedBlocksReferenceKey as he,typedBlocksStructureKey as w,typedBlocksTypeKey as T}from"../invalidation.js";var ge=`
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
`,_e=3,D=e=>`"${e.replace(/"/g,`""`)}"`,O=e=>{let t=e.trim();return t.length>=2&&t.startsWith(`"`)&&t.endsWith(`"`)?t.slice(1,-1):t},ve=e=>{let t=[],n=0,r=(e,n)=>{let r=e.trim();if(r){if(!n&&(r===`AND`||r===`OR`||r===`NOT`)){t.push({kind:`operator`,op:r});return}t.push({kind:`term`,text:r,excluded:n})}};for(;n<e.length;){for(;n<e.length&&/\s/.test(e[n]??``);)n++;if(n>=e.length)break;let t=!1;if(e[n]===`-`&&n+1<e.length&&!/\s/.test(e[n+1]??``)&&(t=!0,n++),e[n]===`"`){n++;let i=n;for(;n<e.length&&e[n]!==`"`;)n++;r(e.slice(i,n),t),e[n]===`"`&&n++;continue}let i=n;for(;n<e.length&&!/\s/.test(e[n]??``);)n++;r(e.slice(i,n),t)}return t},k=e=>e.trim().length>=_e,A=e=>{let t=O(e.trim());return k(t)?{matchQuery:D(t),rankQuery:t}:null},j=e=>{let t=e.trim();if(!k(t))return null;let n=ve(t),r=n.some(e=>e.kind===`term`&&!e.excluded&&k(e.text)),i=O(t),a=[[]],o=[],s=!1,c=!1,l=!1,u=()=>a[a.length-1],d=e=>{s&&u().length>0&&a.push([]),u().push(e),l=!0,s=!1,c=!1},f=e=>k(e)?(d(D(e)),!0):!1;for(let e of n){if(e.kind===`operator`){if(e.op===`OR`){if(l)s=!0;else if(!f(e.op))return A(t);continue}if(e.op===`NOT`){if(l||r)c=!0;else if(!f(e.op))return A(t);continue}if(!l&&!f(e.op))return A(t);continue}if(e.excluded&&!r){if(!f(`-${e.text}`))return A(t);continue}if(c){if(k(e.text))o.push(D(e.text));else return A(t);c=!1,s=!1;continue}if(e.excluded&&r){if(k(e.text))o.push(D(e.text));else return A(t);s=!1;continue}if(!f(e.text))return A(t)}let p=a.filter(e=>e.length>0);if(p.length===0&&k(i))return A(t);if(p.length===0)return null;let m=p.length===1?p[0].join(` `):`(${p.map(e=>e.join(` `)).join(` OR `)})`;return{matchQuery:o.length===0?m:`${m} ${o.map(e=>`NOT ${e}`).join(` `)}`,rankQuery:i}},M=e=>e.replace(/[\\%_]/g,e=>`\\${e}`),N=`
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
`,ye=`
  SELECT ${f(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
`,be=`
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
`,B=e=>e,V={parse:e=>e},xe={parse:e=>e},Se={parse:e=>e},H={parse:e=>e},U=e({name:`core.subtree`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:{parse:e=>e},resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`row`,id:e}),n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(ne,[e]):await n.db.getAll(ee,[e]),i=n.hydrateBlocks(B(r)).map((e,t)=>({...e,depth:r[t].depth}));for(let e of i)n.depend({kind:`parent-edge`,parentId:e.id});return i}}),W=e({name:`core.ancestors`,argsSchema:a({id:s()}),resultSchema:V,resolve:async({id:e},t)=>{t.depend({kind:`row`,id:e});let n=await t.db.getAll(p,[e,e]);return t.hydrateBlocks(B(n))}}),G=e({name:`core.manyAncestors`,argsSchema:a({ids:n(s()).readonly()}),resultSchema:{parse:e=>e},resolve:async({ids:e},t)=>{if(e.length===0)return[];for(let n of e)t.depend({kind:`row`,id:n});let n=await t.db.getAll(re(e.length),[...e]),r=new Map;for(let t of e)r.set(t,[]);for(let e of n){let t=r.get(e.chain_start_id);t&&t.push(e)}return e.map(e=>({startId:e,ancestors:t.hydrateBlocks(B(r.get(e)??[]))}))}}),K=e({name:`core.children`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:V,resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(g,[e]):await n.db.getAll(h,[e]);return n.hydrateBlocks(B(r))}}),Ce=e({name:`core.childIds`,argsSchema:a({id:s(),hydrate:r().optional(),hidePropertyChildren:r().optional()}),resultSchema:n(s()),resolve:async({id:e,hydrate:t=!1,hidePropertyChildren:n=!1},r)=>{if(r.depend({kind:`parent-edge`,parentId:e}),!t)return(n?await r.db.getAll(te,[e]):await r.db.getAll(m,[e])).map(e=>e.id);let i=n?await r.db.getAll(g,[e]):await r.db.getAll(h,[e]);return r.hydrateBlocks(B(i),{declareRowDeps:!1}).map(e=>e.id)}}),we=e({name:`core.byType`,argsSchema:a({workspaceId:s(),type:s()}),resultSchema:V,resolve:async({workspaceId:e,type:t},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:fe,key:T(e,t)});let r=await n.db.getAll(E,[e,t]);return n.hydrateBlocks(B(r))}}),q=a({workspaceId:s(),types:n(s()).optional(),where:o(s(),c()).optional(),referencedBy:u.optional(),match:n(l).optional(),exclude:n(l).optional(),order:t([`created-asc`,`created-desc`]).optional()}),Te=e=>`
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
`,J=(e,t,n)=>{if(e!==void 0)for(let[r,i]of Object.entries(e)){if(n.depend({kind:`plugin`,channel:ce,key:pe(t,r)}),typeof i!=`object`||!i||i instanceof Date||Array.isArray(i))continue;let e=Object.entries(i);if(e.length!==1)continue;let[a,o]=e[0];if(a!==`target`||typeof o!=`object`||!o||Array.isArray(o))continue;let s=o;Object.values(s).some(v)||n.depend({kind:`plugin`,channel:se,key:C(t)}),J(s,t,n)}},Ee=(e,t,n,r={})=>{if(e.sourceField!==void 0){n.depend({kind:`plugin`,channel:ue,key:me(t,e.id,e.sourceField)});return}n.depend({kind:`plugin`,channel:le,key:he(t,e.id)}),r.includeImplicitAncestorStructure&&n.depend({kind:`plugin`,channel:de,key:w(t,e.id)})},De=(e,t,n)=>{for(let r of e)J(r.where,t,n),r.referencedBy!==void 0&&Ee(r.referencedBy,t,n,{includeImplicitAncestorStructure:r.scope===`ancestor`})},Y=(e,t)=>{let n=e.workspaceId,r=e.types??[],i=e.referencedBy,a=e.match??[],o=e.exclude??[];for(let e of r)t.depend({kind:`plugin`,channel:fe,key:T(n,e)});J(e.where,n,t),i!==void 0&&Ee(i,n,t),De(a,n,t),De(o,n,t);let s=Object.values(e.where??{}).some(v),c=a.some(e=>e.referencedBy!==void 0||e.where!==void 0&&Object.values(e.where).some(v));return r.length>0||i!==void 0||s||c||t.depend({kind:`plugin`,channel:se,key:C(n)}),{workspaceId:n,types:r,referencedBy:i,matchPredicates:a,excludePredicates:o}},X=(e,t)=>e.some(e=>e.scope===`ancestor`)||t.some(e=>e.scope===`ancestor`),Z=async(e,t,n)=>{ie(e);let r=ae(e,t.repo.propertySchemas),i=await t.db.getAll(Te(r.sql),r.params);for(let r of i)n===`row`?t.depend({kind:`row`,id:r.anc_id}):t.depend({kind:`plugin`,channel:de,key:w(e.workspaceId,r.anc_id)})},Oe=async(e,t)=>{if(!e.workspaceId)return[];let n=y(e),{workspaceId:r,types:i,referencedBy:a,matchPredicates:o,excludePredicates:s}=Y(n,t);if(X(o,s)&&await Z(n,t,`row`),i.length===1&&n.where===void 0&&a===void 0&&o.length===0&&s.length===0&&n.order!==`created-desc`){let e=await t.db.getAll(E,[r,i[0]]);return t.hydrateBlocks(B(e))}let c=_(n,t.repo.propertySchemas),l=await t.db.getAll(c.sql,[...c.params]);return t.hydrateBlocks(B(l))},ke=async(e,t)=>{if(!e.workspaceId)return[];let n=y(e),{matchPredicates:r,excludePredicates:i}=Y(n,t);X(r,i)&&await Z(n,t,`structure`);let a=_(n,t.repo.propertySchemas,{projection:`ids`});return(await t.db.getAll(a.sql,[...a.params])).map(e=>e.id)},Ae=e({name:`core.typedBlocks`,argsSchema:q,resultSchema:V,resolve:(e,t)=>Oe(e,t)}),je=e({name:`core.typedBlockIds`,argsSchema:q,resultSchema:xe,resolve:(e,t)=>ke(e,t)}),Me=async(e,t)=>{if(!e.workspaceId)return 0;let n=y(e),{matchPredicates:r,excludePredicates:i}=Y(n,t);X(r,i)&&await Z(n,t,`structure`);let a=_(n,t.repo.propertySchemas,{projection:`count`});return(await t.db.get(a.sql,[...a.params]))?.count??0},Ne=e({name:`core.typedBlockCount`,argsSchema:q,resultSchema:Se,resolve:(e,t)=>Me(e,t)}),Pe=e({name:`core.searchByContent`,argsSchema:a({workspaceId:s(),query:s(),limit:i().optional()}),resultSchema:V,resolve:async({workspaceId:e,query:t,limit:n=50},r)=>{let i=j(t);if(i===null)return[];r.depend({kind:`plugin`,channel:oe,key:S(e)});let a=await r.db.getAll(N,[e,i.matchQuery,i.rankQuery,M(i.rankQuery),n]);return r.hydrateBlocks(B(a),{declareRowDeps:!1})}}),Fe=e({name:`core.recentBlocks`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:V,resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:oe,key:S(e)});let r=await n.db.getAll(P,[e,t]);return n.hydrateBlocks(B(r),{declareRowDeps:!1})}}),Q=e({name:`core.firstChildByContent`,argsSchema:a({parentId:s(),content:s()}),resultSchema:H,resolve:async({parentId:e,content:t},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=await n.db.getAll(m,[e]);for(let e of r)n.depend({kind:`row`,id:e.id});let i=await n.db.getOptional(z,[e,t]);return i===null?null:n.hydrateBlocks(B([i]),{declareRowDeps:!1})[0]??null}}),Ie=e({name:`core.aliasesInWorkspace`,argsSchema:a({workspaceId:s(),filter:s().optional()}),resultSchema:n(s()),resolve:async({workspaceId:e,filter:t=``},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:b,key:x(e)});let r=M(t);return(await n.db.getAll(F,[e,t,r,t,r])).map(e=>e.alias)}}),Le=e({name:`core.aliasMatches`,argsSchema:a({workspaceId:s(),filter:s(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s()})),resolve:async({workspaceId:e,filter:t,limit:n=50},r)=>{if(!e)return[];r.depend({kind:`plugin`,channel:b,key:x(e)});let i=M(t),a=await r.db.getAll(R,[e,t,i,t,i,n]);for(let e of a)r.depend({kind:`row`,id:e.blockId});return a}}),Re=e({name:`core.aliasMatchesFuzzy`,argsSchema:a({workspaceId:s(),prefixes:n(s()),query:s().optional(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s(),updatedAt:i()})),resolve:async({workspaceId:e,prefixes:t,query:n=``,limit:r=100},i)=>{if(!e)return[];i.depend({kind:`plugin`,channel:b,key:x(e)});let a=L(t.length),o=n.toLowerCase(),s=[e,...t.map(M),o,M(o),r],c=await i.db.getAll(a,s);for(let e of c)i.depend({kind:`row`,id:e.blockId});return c}}),ze=e({name:`core.blockTypesByIds`,argsSchema:a({workspaceId:s(),blockIds:n(s()).max(200)}),resultSchema:n(a({blockId:s(),type:s()})),resolve:async({workspaceId:e,blockIds:t},n)=>{if(!e||t.length===0)return[];for(let e of t)n.depend({kind:`row`,id:e});let r=t.map(()=>`?`).join(`, `);return n.db.getAll(`SELECT b.id AS blockId, je.value AS type
       FROM blocks b, json_each(b.properties_json, '$.types') je
       WHERE b.workspace_id = ?
         AND b.deleted = 0
         AND b.id IN (${r})
         AND typeof(je.value) = 'text'
       ORDER BY b.id, je.key`,[e,...t])}}),Be=e({name:`core.aliasLookup`,argsSchema:a({workspaceId:s(),alias:s()}),resultSchema:H,resolve:async({workspaceId:e,alias:t},n)=>{if(!e||!t)return null;n.depend({kind:`plugin`,channel:b,key:x(e)});let r=await n.db.getOptional(I,[e,t]);return r===null?null:n.hydrateBlocks(B([r]))[0]??null}}),$=e({name:`core.findExtensionBlocks`,argsSchema:a({workspaceId:s()}),resultSchema:V,resolve:async({workspaceId:e},t)=>{if(!e)return[];let n=await t.db.getAll(E,[e,`extension`]);return t.hydrateBlocks(B(n))}}),Ve=[U,W,G,K,Ce,we,Ae,je,Ne,Pe,Fe,Q,Ie,Le,Re,ze,Be,$];export{Ve as KERNEL_QUERIES,F as SELECT_ALIASES_IN_WORKSPACE_SQL,R as SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,ye as SELECT_BLOCKS_BY_ALIAS_IN_WORKSPACE_SQL,N as SELECT_BLOCKS_BY_CONTENT_SQL,E as SELECT_BLOCKS_BY_TYPE_SQL,be as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,I as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,ge as SELECT_BLOCK_BY_ID_SQL,z as SELECT_FIRST_CHILD_BY_CONTENT_SQL,P as SELECT_RECENT_BLOCKS_SQL,Be as aliasLookupQuery,Re as aliasMatchesFuzzyQuery,Le as aliasMatchesQuery,Ie as aliasesInWorkspaceQuery,W as ancestorsQuery,ze as blockTypesByIdsQuery,L as buildFuzzyAliasMatchesSql,we as byTypeQuery,Ce as childIdsQuery,K as childrenQuery,j as compileBlocksContentSearchQuery,$ as findExtensionBlocksQuery,Q as firstChildByContentQuery,G as manyAncestorsQuery,Fe as recentBlocksQuery,Me as resolveTypedBlockCount,ke as resolveTypedBlockIds,Oe as resolveTypedBlocks,Pe as searchByContentQuery,U as subtreeQuery,Ne as typedBlockCountQuery,je as typedBlockIdsQuery,Ae as typedBlocksQuery};
//# sourceMappingURL=kernelQueries.js.map