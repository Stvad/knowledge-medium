import{DAILY_NOTE_TYPE as e,dailyNoteDateProp as t}from"./schema.js";import{dailyNoteDateValue as n}from"./dailyNotes.js";var r=`
  SELECT b.id AS id, MIN(je.value) AS iso
  FROM blocks b
  JOIN block_types bt ON bt.block_id = b.id AND bt.type = '${e}'
  JOIN json_each(b.properties_json, '$.alias') je
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND je.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(je.value) = je.value
    AND json_extract(b.properties_json, '$."${t.name}"') IS NULL
  GROUP BY b.id
`,i=500,a={id:`daily-note-date-from-alias-v2`,run:async({workspaceId:e,getAll:a,tx:o})=>{let s=await a(r,[e]);for(let e=0;e<s.length;e+=i){let r=s.slice(e,e+i);await o(async e=>{for(let{id:i,iso:a}of r){let r=await e.get(i);!r||r.deleted||r.properties[t.name]===void 0&&await e.setProperty(i,t,n(a))}},{description:`backfill daily-note:date from ISO alias`})}}};export{a as dailyNoteDateBackfill};
//# sourceMappingURL=backfill.js.map