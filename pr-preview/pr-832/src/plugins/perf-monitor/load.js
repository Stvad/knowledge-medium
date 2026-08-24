import{stateChildBlockId as e}from"../../data/derivedIds.js";import{getClientId as t}from"../../utils/clientId.js";import{pluginUIStateBlockId as n}from"../../data/stateBlocks.js";var r=40,i=async(r,i,a,o)=>{let s=e(n(i,r.user.id,a),t()),c=await r.db.getAll(`SELECT json_extract(properties_json, ?) AS payload
       FROM blocks
      WHERE parent_id = ? AND deleted = 0
      ORDER BY order_key
      LIMIT ?`,[o,s,40]),l=[];for(let e of c)if(e.payload)try{l.push(JSON.parse(e.payload))}catch{}return l.sort((e,t)=>t.recordedAt-e.recordedAt)};export{r as HISTORY_LIMIT,i as loadRecords};
//# sourceMappingURL=load.js.map