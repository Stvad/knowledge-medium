import{BLOCK_STORAGE_COLUMNS as e}from"../../blockSchema.js";var t=(e,t)=>e!==null&&e!==0&&e===t,n=(e,t)=>e.deleted&&(t===void 0||t.deleted),r=(e,r)=>t(r?.updatedAt??null,e.updatedAt)||n(e,r),i=(e,n,r)=>e===`defer`?{kind:`defer`}:r.hasPendingUpload||t(r.localUpdatedAt,n)?{kind:`skip-stale`}:{kind:`apply`,decrypt:e===`decrypt`},a=`
  SELECT why FROM (
    SELECT 'deep' AS why FROM (SELECT 1 FROM blocks_synced_changes LIMIT 1 OFFSET ?)
    UNION ALL
    SELECT 'draining' AS why
      FROM (SELECT seq, id, op FROM blocks_synced_changes ORDER BY seq LIMIT ?) c
      LEFT JOIN blocks_synced s ON s.id = c.id
      LEFT JOIN blocks b ON b.id = c.id
     WHERE c.op = 'delete'
        OR s.id IS NULL
        OR b.id IS NULL
        OR b.updated_at = 0
        OR b.updated_at <> s.updated_at
  ) LIMIT 1`,o=1e4,s=`
     WHERE s.workspace_id = ? AND s.needs_apply = 1
       AND NOT EXISTS (SELECT 1 FROM blocks_synced_changes c WHERE c.id = s.id)`,c=`
  SELECT COUNT(*) AS behind FROM (
    SELECT 1 FROM blocks_synced s
    ${s}
     LIMIT ?
  )`,l=`
  SELECT s.id FROM blocks_synced s
  ${s}
   ORDER BY s.id`,u=`
  SELECT COUNT(*) AS behind FROM blocks_synced s
  ${s}`,d=1e3,f=`
  UPDATE blocks_synced SET needs_apply = 0
   WHERE needs_apply = 1
     AND (
           EXISTS (
             SELECT 1 FROM blocks b
              WHERE b.id = blocks_synced.id
                AND b.updated_at <> 0
                AND b.updated_at = blocks_synced.updated_at
           )
           OR (
             blocks_synced.deleted = 1
             AND COALESCE(
                   (SELECT b.deleted FROM blocks b WHERE b.id = blocks_synced.id), 1
                 ) = 1
           )
           OR EXISTS (
             SELECT 1 FROM blocks b
              WHERE b.id = blocks_synced.id
                AND ${e.map(e=>e.name).filter(e=>e!==`id`).map(e=>`b.${e} IS blocks_synced.${e}`).join(` AND `)}
           )
         )
`;export{f as SEED_STAGING_NEEDS_APPLY_SQL,o as STAGED_SCAN_LIMIT,a as STAGED_VIEW_GAP_SQL,d as WORKSPACE_UNAPPLIED_COUNT_CAP,u as WORKSPACE_UNAPPLIED_EXACT_COUNT_SQL,l as WORKSPACE_UNAPPLIED_IDS_SQL,c as WORKSPACE_UNAPPLIED_SQL,r as blocksAlreadyReflects,i as decideStagingRow,t as localHoldsStagedVersion};
//# sourceMappingURL=reconcile.js.map