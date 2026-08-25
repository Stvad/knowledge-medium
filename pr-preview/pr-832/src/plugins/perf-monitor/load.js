import{stateChildBlockId as e}from"../../data/derivedIds.js";import{getClientId as t}from"../../utils/clientId.js";import{pluginUIStateBlockId as n}from"../../data/stateBlocks.js";var r=`$."interaction-metrics:record"`,i=`$.startupRecord`,a=e=>typeof e.queries==`object`&&e.queries!==null&&typeof e.fanout==`object`&&e.fanout!==null&&typeof e.writes==`number`&&typeof e.blockCount==`number`,o=e=>typeof e.timeOriginMs==`number`,s=40,c=async(r,i,a,o,s)=>{let c=e(n(i,r.user.id,a),t()),l=await r.db.getAll(`SELECT id, json_extract(properties_json, ?) AS payload
       FROM blocks
      WHERE parent_id = ? AND deleted = 0
        AND json_extract(properties_json, ?) IS NOT NULL
      ORDER BY order_key
      LIMIT ?`,[o,c,o,40]),u=[];for(let e of l)if(e.payload)try{let t=JSON.parse(e.payload);typeof t?.recordedAt==`number`&&s(t)&&u.push({id:e.id,record:t})}catch{}return u.sort((e,t)=>t.record.recordedAt-e.record.recordedAt)};export{s as HISTORY_LIMIT,r as INTERACTION_RECORD_PATH,i as STARTUP_RECORD_PATH,a as isUsableInteractionRecord,o as isUsableStartupRecord,c as loadRecords};
//# sourceMappingURL=load.js.map