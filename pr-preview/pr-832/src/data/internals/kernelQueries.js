import{defineQuery as e}from"../api/query.js";import{_enum as t,array as n,boolean as r,number as i,object as a,record as o,string as s,unknown as c}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{blockPredicateSchema as l,referenceFilterSchema as u}from"../api/typedBlockQuery.js";import"../api/index.js";import{seedKeyProp as ee}from"../properties.js";import{SYSTEM_BLOCK_TYPES as d,USER_TYPE as f}from"../blockTypes.js";import{userStateRootBlockIds as p}from"../derivedIds.js";import{propertyDefinitionBlockId as te}from"../definitionSeeds.js";import{refCodecKind as ne}from"./refProjection.js";import{SELECT_BLOCK_COLUMNS_SQL as re,buildQualifiedBlockColumnsSql as m}from"../blockSchema.js";import{ANCESTORS_SQL as ie,CHILDREN_IDS_SQL as ae,CHILDREN_SQL as h,SUBTREE_SQL as oe,VISIBLE_CHILDREN_IDS_SQL as se,VISIBLE_CHILDREN_SQL as g,VISIBLE_SUBTREE_SQL as ce,manyAncestorsSql as _}from"./treeQueries.js";import{assertAncestorWalkBounded as le,buildCandidatesCte as ue,compileTypedBlockQuery as v,inlineJsonPath as de,isSelectiveWhereValue as y,normalizeTypedBlockQuery as b}from"./typedBlockQuery.js";import{KERNEL_ALIASES_CHANNEL as x,KERNEL_CONTENT_CHANNEL as S,TYPED_BLOCKS_LIVE_CHANNEL as fe,TYPED_BLOCKS_PROPERTY_CHANNEL as pe,TYPED_BLOCKS_REFERENCE_CHANNEL as me,TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL as he,TYPED_BLOCKS_STRUCTURE_CHANNEL as C,TYPED_BLOCKS_TYPE_CHANNEL as w,kernelAliasesKey as T,kernelContentKey as E,typedBlocksLiveKey as D,typedBlocksPropertyKey as ge,typedBlocksReferenceFieldKey as _e,typedBlocksReferenceKey as ve,typedBlocksStructureKey as O,typedBlocksTypeKey as k}from"../invalidation.js";var ye=`
  SELECT ${re}
  FROM blocks
  WHERE id = ?
    AND deleted = 0
`,A=`
  SELECT ${m(`b`)}
  FROM blocks b
  JOIN block_types bt
    ON bt.block_id = b.id
   AND bt.workspace_id = b.workspace_id
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND bt.type = ?
  ORDER BY b.created_at ASC, b.id ASC
`,be=3,j=e=>`"${e.replace(/"/g,`""`)}"`,M=e=>{let t=e.trim();return t.length>=2&&t.startsWith(`"`)&&t.endsWith(`"`)?t.slice(1,-1):t},xe=e=>{let t=[],n=0,r=(e,n)=>{let r=e.trim();if(r){if(!n&&(r===`AND`||r===`OR`||r===`NOT`)){t.push({kind:`operator`,op:r});return}t.push({kind:`term`,text:r,excluded:n})}};for(;n<e.length;){for(;n<e.length&&/\s/.test(e[n]??``);)n++;if(n>=e.length)break;let t=!1;if(e[n]===`-`&&n+1<e.length&&!/\s/.test(e[n+1]??``)&&(t=!0,n++),e[n]===`"`){n++;let i=n;for(;n<e.length&&e[n]!==`"`;)n++;r(e.slice(i,n),t),e[n]===`"`&&n++;continue}let i=n;for(;n<e.length&&!/\s/.test(e[n]??``);)n++;r(e.slice(i,n),t)}return t},N=e=>e.trim().length>=be,P=e=>{let t=M(e.trim());return N(t)?{matchQuery:j(t),rankQuery:t}:null},F=e=>{let t=e.trim();if(!N(t))return null;let n=xe(t),r=n.some(e=>e.kind===`term`&&!e.excluded&&N(e.text)),i=M(t),a=[[]],o=[],s=!1,c=!1,l=!1,u=()=>a[a.length-1],ee=e=>{s&&u().length>0&&a.push([]),u().push(e),l=!0,s=!1,c=!1},d=e=>N(e)?(ee(j(e)),!0):!1;for(let e of n){if(e.kind===`operator`){if(e.op===`OR`){if(l)s=!0;else if(!d(e.op))return P(t);continue}if(e.op===`NOT`){if(l||r)c=!0;else if(!d(e.op))return P(t);continue}if(!l&&!d(e.op))return P(t);continue}if(e.excluded&&!r){if(!d(`-${e.text}`))return P(t);continue}if(c){if(N(e.text))o.push(j(e.text));else return P(t);c=!1,s=!1;continue}if(e.excluded&&r){if(N(e.text))o.push(j(e.text));else return P(t);s=!1;continue}if(!d(e.text))return P(t)}let f=a.filter(e=>e.length>0);if(f.length===0&&N(i))return P(t);if(f.length===0)return null;let p=f.length===1?f[0].join(` `):`(${f.map(e=>e.join(` `)).join(` OR `)})`;return{matchQuery:o.length===0?p:`${p} ${o.map(e=>`NOT ${e}`).join(` `)}`,rankQuery:i}},I=e=>e.replace(/[\\%_]/g,e=>`\\${e}`),L=`
  SELECT ${m(`b`)}
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
`,R=`
  SELECT ${re}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
  ORDER BY coalesce(user_updated_at, updated_at) DESC, id ASC
  LIMIT ?
`,z=`
  SELECT block_id AS id FROM block_types
   WHERE workspace_id = ? AND type = ?
`,B=`
  WITH RECURSIVE user_state(id) AS (
    SELECT value FROM json_each(?)
    UNION
    SELECT b.id FROM blocks b
      JOIN user_state ON b.parent_id = user_state.id
  )
  SELECT ${m(`blocks`)}
  FROM blocks
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND blocks.content != ''
    AND blocks.id NOT IN (SELECT id FROM user_state)
    AND json_extract(blocks.properties_json, '$."${ee.name}"') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM block_types bt
       WHERE bt.block_id = blocks.id
         AND bt.type IN (${d.map(()=>`?`).join(`, `)})
    )
  ORDER BY coalesce(blocks.user_updated_at, blocks.updated_at) DESC, blocks.id ASC
  LIMIT ?
`,V=(e,t,n)=>[JSON.stringify(e),t,...d,n],H=`
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
`,U=`
  SELECT ${m(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at, blocks.id
  LIMIT 1
`,Se=`
  SELECT ${m(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at, blocks.id
`,Ce=`
  SELECT ${m(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.id != ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at, blocks.id
  LIMIT 1
`,we=e=>`
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
  `,Te=`
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
`,Ee=`
  SELECT ${m(`child`)}
  FROM blocks AS child
  WHERE child.parent_id = ?
    AND child.deleted = 0
    AND child.content = ?
  ORDER BY child.order_key, child.id
  LIMIT 1
`,W=e=>e,G={parse:e=>e},De={parse:e=>e},Oe={parse:e=>e},ke={parse:e=>e},Ae=e({name:`core.subtree`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:{parse:e=>e},resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`row`,id:e}),n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(ce,[e,...K(n.repo)]):await n.db.getAll(oe,[e]),i=n.hydrateBlocks(W(r)).map((e,t)=>({...e,depth:r[t].depth}));for(let e of i)n.depend({kind:`parent-edge`,parentId:e.id});return i}}),je=e({name:`core.ancestors`,argsSchema:a({id:s()}),resultSchema:G,resolve:async({id:e},t)=>{t.depend({kind:`row`,id:e});let n=await t.db.getAll(ie,[e,e]);return t.hydrateBlocks(W(n))}}),Me=e({name:`core.manyAncestors`,argsSchema:a({ids:n(s()).readonly()}),resultSchema:{parse:e=>e},resolve:async({ids:e},t)=>{if(e.length===0)return[];for(let n of e)t.depend({kind:`row`,id:n});let n=await t.db.getAll(_(e.length),[...e]),r=new Map;for(let t of e)r.set(t,[]);for(let e of n){let t=r.get(e.chain_start_id);t&&t.push(e)}return e.map(e=>({startId:e,ancestors:t.hydrateBlocks(W(r.get(e)??[]))}))}}),Ne=new WeakMap,K=e=>{let t=e.propertyDefinitions;if(!t)return[`[]`,``];let n=Ne.get(t);if(n)return n;let r=[];for(let e of t.seedsByKey.keys())r.push(te(t.workspaceId,e));let i=[JSON.stringify(r),t.workspaceId];return Ne.set(t,i),i},Pe=e({name:`core.children`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:G,resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(g,[e,...K(n.repo)]):await n.db.getAll(h,[e]);return n.hydrateBlocks(W(r))}}),Fe=e({name:`core.childIds`,argsSchema:a({id:s(),hydrate:r().optional(),hidePropertyChildren:r().optional()}),resultSchema:n(s()),resolve:async({id:e,hydrate:t=!1,hidePropertyChildren:n=!1},r)=>{if(r.depend({kind:`parent-edge`,parentId:e}),!t)return(n?await r.db.getAll(se,[e,...K(r.repo)]):await r.db.getAll(ae,[e])).map(e=>e.id);let i=n?await r.db.getAll(g,[e,...K(r.repo)]):await r.db.getAll(h,[e]);return r.hydrateBlocks(W(i),{declareRowDeps:!1}).map(e=>e.id)}}),Ie=e({name:`core.byType`,argsSchema:a({workspaceId:s(),type:s()}),resultSchema:G,resolve:async({workspaceId:e,type:t},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:w,key:k(e,t)});let r=await n.db.getAll(A,[e,t]);return n.hydrateBlocks(W(r))}}),q=a({workspaceId:s(),types:n(s()).optional(),where:o(s(),c()).optional(),referencedBy:u.optional(),match:n(l).optional(),exclude:n(l).optional(),order:t([`created-asc`,`created-desc`]).optional()}),Le=`a`,J=`t`,Re=(e,t)=>`
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
  SELECT DISTINCT '${Le}' AS dep_kind, anc_id AS dep_id FROM walk${t.map(e=>`
  UNION
  ${e}`).join(``)}
`,Y=(e,t,n,r)=>{if(e!==void 0)for(let[i,a]of Object.entries(e)){if(n.depend({kind:`plugin`,channel:pe,key:ge(t,i)}),typeof a!=`object`||!a||a instanceof Date||Array.isArray(a))continue;let e=Object.entries(a);if(e.length!==1)continue;let[o,s]=e[0];if(o!==`target`||typeof s!=`object`||!s||Array.isArray(s))continue;let c=s;Object.values(c).some(y)||(r?r.add(i):n.depend({kind:`plugin`,channel:fe,key:D(t)})),Y(c,t,n,null)}},ze=(e,t,n,r={})=>{if(e.sourceField!==void 0){n.depend({kind:`plugin`,channel:he,key:_e(t,e.id,e.sourceField)});return}n.depend({kind:`plugin`,channel:me,key:ve(t,e.id)}),r.includeImplicitAncestorStructure&&n.depend({kind:`plugin`,channel:C,key:O(t,e.id)})},Be=(e,t,n,r)=>{for(let i of e)Y(i.where,t,n,i.scope===`ancestor`?r:null),i.referencedBy!==void 0&&ze(i.referencedBy,t,n,{includeImplicitAncestorStructure:i.scope===`ancestor`})},X=(e,t)=>{let n=e.workspaceId,r=e.types??[],i=e.referencedBy,a=e.match??[],o=e.exclude??[];for(let e of r)t.depend({kind:`plugin`,channel:w,key:k(n,e)});let s=new Set;Y(e.where,n,t,null),i!==void 0&&ze(i,n,t),Be(a,n,t,s),Be(o,n,t,s);let c=Object.values(e.where??{}).some(y),l=a.some(e=>e.referencedBy!==void 0||e.where!==void 0&&Object.values(e.where).some(y));return r.length>0||i!==void 0||c||l||t.depend({kind:`plugin`,channel:fe,key:D(n)}),{workspaceId:n,types:r,referencedBy:i,matchPredicates:a,excludePredicates:o,ancestorTargetProps:s}},Z=(e,t)=>e.some(e=>e.scope===`ancestor`)||t.some(e=>e.scope===`ancestor`),Ve=(e,t)=>{let n=[];for(let r of[...e].sort()){let e=`json_extract(b.properties_json, ${de(r)})`,i=ne(t.get(r));i===`ref`?n.push(`SELECT DISTINCT '${J}', ${e}\n  FROM walk JOIN blocks b ON b.id = walk.anc_id\n  WHERE ${e} IS NOT NULL`):i===`refList`&&n.push(`SELECT DISTINCT '${J}', je.value\n  FROM walk JOIN blocks b ON b.id = walk.anc_id, json_each(${e}) je`)}return n},Q=async(e,t,n,r)=>{le(e);let i=ue(e,t.repo.propertySchemas),a=await t.db.getAll(Re(i.sql,Ve(r,t.repo.propertySchemas)),i.params);for(let r of a)if(r.dep_id!==null){if(r.dep_kind===J){t.depend({kind:`plugin`,channel:C,key:O(e.workspaceId,r.dep_id)});continue}n===`row`?t.depend({kind:`row`,id:r.dep_id}):t.depend({kind:`plugin`,channel:C,key:O(e.workspaceId,r.dep_id)})}},He=async(e,t)=>{if(!e.workspaceId)return[];let n=b(e),{workspaceId:r,types:i,referencedBy:a,matchPredicates:o,excludePredicates:s,ancestorTargetProps:c}=X(n,t);if(Z(o,s)&&await Q(n,t,`row`,c),i.length===1&&n.where===void 0&&a===void 0&&o.length===0&&s.length===0&&n.order!==`created-desc`){let e=await t.db.getAll(A,[r,i[0]]);return t.hydrateBlocks(W(e))}let l=v(n,t.repo.propertySchemas),u=await t.db.getAll(l.sql,[...l.params]);return t.hydrateBlocks(W(u))},Ue=async(e,t)=>{if(!e.workspaceId)return[];let n=b(e),{matchPredicates:r,excludePredicates:i,ancestorTargetProps:a}=X(n,t);Z(r,i)&&await Q(n,t,`structure`,a);let o=v(n,t.repo.propertySchemas,{projection:`ids`});return(await t.db.getAll(o.sql,[...o.params])).map(e=>e.id)},We=e({name:`core.typedBlocks`,argsSchema:q,resultSchema:G,resolve:(e,t)=>He(e,t)}),$=e({name:`core.typedBlockIds`,argsSchema:q,resultSchema:De,resolve:(e,t)=>Ue(e,t)}),Ge=async(e,t)=>{if(!e.workspaceId)return 0;let n=b(e),{matchPredicates:r,excludePredicates:i,ancestorTargetProps:a}=X(n,t);Z(r,i)&&await Q(n,t,`structure`,a);let o=v(n,t.repo.propertySchemas,{projection:`count`});return(await t.db.get(o.sql,[...o.params]))?.count??0},Ke=e({name:`core.typedBlockCount`,argsSchema:q,resultSchema:Oe,resolve:(e,t)=>Ge(e,t)}),qe=e({name:`core.searchByContent`,argsSchema:a({workspaceId:s(),query:s(),limit:i().optional()}),resultSchema:G,resolve:async({workspaceId:e,query:t,limit:n=50},r)=>{let i=F(t);if(i===null)return[];r.depend({kind:`plugin`,channel:S,key:E(e)});let a=await r.db.getAll(L,[e,i.matchQuery,i.rankQuery,I(i.rankQuery),n]);return r.hydrateBlocks(W(a),{declareRowDeps:!1})}}),Je=async(e,t)=>(await e.db.getAll(z,[t,f])).flatMap(e=>p(e.id)),Ye=e({name:`core.recentBlocks`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:G,resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:S,key:E(e)});let r=await n.db.getAll(R,[e,t]);return n.hydrateBlocks(W(r),{declareRowDeps:!1})}}),Xe={parse:e=>e},Ze=async(e,t,n)=>{n.depend({kind:`plugin`,channel:S,key:E(e)});let r=await n.db.getAll(B,V(await Je(n,e),e,t));return n.hydrateBlocks(W(r),{declareRowDeps:!1})},Qe=e({name:`core.recentUserBlocks`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:{parse:e=>e},resolve:async({workspaceId:e,limit:t=50},n)=>e?Ze(e,t,n):[]}),$e=e({name:`core.recentActivity`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:Xe,resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];let r=await Ze(e,t,n);if(r.length===0)return[];let i=await n.db.getAll(_(r.length),r.map(e=>e.id)),a=new Map;for(let e of r)a.set(e.id,[]);for(let e of i)a.get(e.chain_start_id)?.push(e);return r.map(t=>{let r=n.hydrateBlocks(W(a.get(t.id)??[]),{declareRowDeps:!1});for(let i of[t,...r])n.depend({kind:`plugin`,channel:C,key:O(e,i.id)});return{block:t,ancestors:r}})}}),et=e({name:`core.firstChildByContent`,argsSchema:a({parentId:s(),content:s()}),resultSchema:ke,resolve:async({parentId:e,content:t},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=await n.db.getAll(ae,[e]);for(let e of r)n.depend({kind:`row`,id:e.id});let i=await n.db.getOptional(Ee,[e,t]);return i===null?null:n.hydrateBlocks(W([i]),{declareRowDeps:!1})[0]??null}}),tt=e({name:`core.aliasesInWorkspace`,argsSchema:a({workspaceId:s(),filter:s().optional()}),resultSchema:n(s()),resolve:async({workspaceId:e,filter:t=``},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:x,key:T(e)});let r=I(t);return(await n.db.getAll(H,[e,t,r,t,r])).map(e=>e.alias)}}),nt=e({name:`core.aliasMatches`,argsSchema:a({workspaceId:s(),filter:s(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s()})),resolve:async({workspaceId:e,filter:t,limit:n=50},r)=>{if(!e)return[];r.depend({kind:`plugin`,channel:x,key:T(e)});let i=I(t),a=await r.db.getAll(Te,[e,t,i,t,i,n]);for(let e of a)r.depend({kind:`row`,id:e.blockId});return a}}),rt=e({name:`core.aliasMatchesFuzzy`,argsSchema:a({workspaceId:s(),prefixes:n(s()),query:s().optional(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s(),updatedAt:i()})),resolve:async({workspaceId:e,prefixes:t,query:n=``,limit:r=100},i)=>{if(!e)return[];i.depend({kind:`plugin`,channel:x,key:T(e)});let a=we(t.length),o=n.toLowerCase(),s=[e,...t.map(I),o,I(o),r],c=await i.db.getAll(a,s);for(let e of c)i.depend({kind:`row`,id:e.blockId});return c}}),it=e({name:`core.blockTypesByIds`,argsSchema:a({workspaceId:s(),blockIds:n(s()).max(200)}),resultSchema:n(a({blockId:s(),type:s()})),resolve:async({workspaceId:e,blockIds:t},n)=>{if(!e||t.length===0)return[];for(let e of t)n.depend({kind:`row`,id:e});let r=t.map(()=>`?`).join(`, `);return n.db.getAll(`SELECT b.id AS blockId, je.value AS type
       FROM blocks b, json_each(b.properties_json, '$.types') je
       WHERE b.workspace_id = ?
         AND b.deleted = 0
         AND b.id IN (${r})
         AND json_type(b.properties_json, '$.types') = 'array'
         AND typeof(je.value) = 'text'
       ORDER BY b.id, je.key`,[e,...t])}}),at=e({name:`core.aliasClaimantCounts`,argsSchema:a({workspaceId:s(),aliases:n(s()).max(200)}),resultSchema:n(a({alias:s(),claimants:i()})),resolve:async({workspaceId:e,aliases:t},n)=>{if(!e||t.length===0)return[];n.depend({kind:`plugin`,channel:x,key:T(e)});let r=t.map(()=>`?`).join(`, `);return n.db.getAll(`SELECT ba.alias AS alias, count(*) AS claimants
       FROM block_aliases ba
       JOIN blocks b ON b.id = ba.block_id
       WHERE ba.workspace_id = ?
         AND ba.alias IN (${r})
         AND b.deleted = 0
       GROUP BY ba.alias`,[e,...t])}}),ot=e({name:`core.aliasClaimants`,argsSchema:a({workspaceId:s(),alias:s()}),resultSchema:G,resolve:async({workspaceId:e,alias:t},n)=>{if(!e||!t)return[];n.depend({kind:`plugin`,channel:x,key:T(e)});let r=await n.db.getAll(Se,[e,t]);return n.hydrateBlocks(W(r))}}),st=e({name:`core.aliasLookup`,argsSchema:a({workspaceId:s(),alias:s()}),resultSchema:ke,resolve:async({workspaceId:e,alias:t},n)=>{if(!e||!t)return null;n.depend({kind:`plugin`,channel:x,key:T(e)});let r=await n.db.getOptional(U,[e,t]);return r===null?null:n.hydrateBlocks(W([r]))[0]??null}}),ct=e({name:`core.findExtensionBlocks`,argsSchema:a({workspaceId:s()}),resultSchema:G,resolve:async({workspaceId:e},t)=>{if(!e)return[];let n=await t.db.getAll(A,[e,`extension`]);return t.hydrateBlocks(W(n))}}),lt=[Ae,je,Me,Pe,Fe,Ie,We,$,Ke,qe,Ye,Qe,$e,et,tt,nt,rt,it,at,ot,st,ct];export{lt as KERNEL_QUERIES,H as SELECT_ALIASES_IN_WORKSPACE_SQL,Te as SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,Se as SELECT_BLOCKS_BY_ALIAS_IN_WORKSPACE_SQL,L as SELECT_BLOCKS_BY_CONTENT_SQL,A as SELECT_BLOCKS_BY_TYPE_SQL,Ce as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,U as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,ye as SELECT_BLOCK_BY_ID_SQL,Ee as SELECT_FIRST_CHILD_BY_CONTENT_SQL,R as SELECT_RECENT_BLOCKS_SQL,B as SELECT_RECENT_USER_BLOCKS_SQL,z as SELECT_USER_PAGE_IDS_SQL,at as aliasClaimantCountsQuery,ot as aliasClaimantsQuery,st as aliasLookupQuery,rt as aliasMatchesFuzzyQuery,nt as aliasMatchesQuery,tt as aliasesInWorkspaceQuery,je as ancestorsQuery,it as blockTypesByIdsQuery,we as buildFuzzyAliasMatchesSql,Ie as byTypeQuery,Fe as childIdsQuery,Pe as childrenQuery,F as compileBlocksContentSearchQuery,I as escapeLikePattern,ct as findExtensionBlocksQuery,et as firstChildByContentQuery,Me as manyAncestorsQuery,$e as recentActivityQuery,Ye as recentBlocksQuery,V as recentUserBlocksParams,Qe as recentUserBlocksQuery,K as registrySeedParams,Ge as resolveTypedBlockCount,Ue as resolveTypedBlockIds,He as resolveTypedBlocks,qe as searchByContentQuery,Ae as subtreeQuery,Ke as typedBlockCountQuery,$ as typedBlockIdsQuery,We as typedBlocksQuery};
//# sourceMappingURL=kernelQueries.js.map