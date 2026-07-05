import{dailyNoteDateProp as e}from"./schema.js";var t=`$."${e.name}"`,n={id:`daily-notes.local-schema`,statements:[`
  CREATE INDEX IF NOT EXISTS idx_blocks_daily_note_date
  ON blocks (json_extract(properties_json, '${t}'))
  WHERE deleted = 0
    AND json_extract(properties_json, '${t}') IS NOT NULL
`]};export{n as dailyNotesLocalSchema};
//# sourceMappingURL=localSchema.js.map