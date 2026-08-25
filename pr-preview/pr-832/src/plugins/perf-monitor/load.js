import{stateChildBlockId as e}from"../../data/derivedIds.js";import{getClientId as t}from"../../utils/clientId.js";import{pluginUIStateBlockId as n}from"../../data/stateBlocks.js";var r=`$."interaction-metrics:record"`,i=`$.startupRecord`,a=40,o=async(r,i,a,o)=>{let s=e(n(i,r.user.id,a),t()),c=await r.db.getAll(`SELECT id, json_extract(properties_json, ?) AS payload
       FROM blocks
      WHERE parent_id = ? AND deleted = 0
        AND json_extract(properties_json, ?) IS NOT NULL
      ORDER BY order_key
      LIMIT ?`,[o,s,o,40]),l=[];for(let e of c)if(e.payload)try{let t=JSON.parse(e.payload);typeof t?.recordedAt==`number`&&l.push({id:e.id,record:t})}catch{}return l.sort((e,t)=>t.record.recordedAt-e.record.recordedAt)};export{a as HISTORY_LIMIT,r as INTERACTION_RECORD_PATH,i as STARTUP_RECORD_PATH,o as loadRecords};
//# sourceMappingURL=load.js.map