import{ChangeScope as e}from"../../data/api/changeScope.js";import"../../data/api/index.js";import{DAILY_NOTE_TYPE as t,dailyNoteDateProp as n}from"./schema.js";import{dailyNoteDateValue as r}from"./dailyNotes.js";var i=`
  SELECT b.id AS id, MIN(je.value) AS iso
  FROM blocks b
  JOIN block_types bt ON bt.block_id = b.id AND bt.type = '${t}'
  JOIN json_each(b.properties_json, '$.alias') je
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND je.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(je.value) = je.value
    AND json_extract(b.properties_json, '$."${n.name}"') IS NULL
  GROUP BY b.id
`,a=500,o={id:`daily-note-date-from-alias-v2`,run:async({workspaceId:t,getAll:o,tx:s})=>{let c=await o(i,[t]);for(let t=0;t<c.length;t+=a){let i=c.slice(t,t+a);await s(async e=>{for(let{id:t,iso:a}of i){let i=await e.get(t);!i||i.deleted||i.properties[n.name]===void 0&&await e.setProperty(t,n,r(a))}},{scope:e.BlockDefault,description:`backfill daily-note:date from ISO alias`})}}};export{o as dailyNoteDateBackfill};
//# sourceMappingURL=backfill.js.map