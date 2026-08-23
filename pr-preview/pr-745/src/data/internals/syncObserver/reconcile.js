var e=(e,t)=>e!==null&&e!==0&&e===t,t=(e,t)=>e.deleted&&(t===void 0||t.deleted),n=(n,r)=>e(r?.updatedAt??null,n.updatedAt)||t(n,r),r=(t,n,r)=>t===`defer`?{kind:`defer`}:r.hasPendingUpload||e(r.localUpdatedAt,n)?{kind:`skip-stale`}:{kind:`apply`,decrypt:t===`decrypt`},i=`
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
  ) LIMIT 1`,a=1e4,o=`
  SELECT COUNT(*) AS behind FROM (
    SELECT 1 FROM blocks_synced s
     WHERE s.workspace_id = ? AND s.needs_apply = 1
       AND NOT EXISTS (SELECT 1 FROM blocks_synced_changes c WHERE c.id = s.id)
     LIMIT ?
  )`,s=1e3,c=`
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
         )
`;export{c as SEED_STAGING_NEEDS_APPLY_SQL,a as STAGED_SCAN_LIMIT,i as STAGED_VIEW_GAP_SQL,s as WORKSPACE_UNAPPLIED_COUNT_CAP,o as WORKSPACE_UNAPPLIED_SQL,n as blocksAlreadyReflects,r as decideStagingRow,e as localHoldsStagedVersion};
//# sourceMappingURL=reconcile.js.map