import sqlite3 from 'better-sqlite3';

type Db = ReturnType<typeof sqlite3>;
function columns(db: Db, table: string): string[] {
  return db.prepare<{table: string}>(`SELECT name FROM PRAGMA_TABLE_INFO($table);`).all({table}).map(o => o.name);
}

// Largely following https://blog.budgetwithbuckets.com/2018/08/27/sqlite-changelog.html
const JUST_INSERT_TABLE = `
-- Change log table
CREATE TABLE IF NOT EXISTS _change_log (
    id INTEGER PRIMARY KEY,
    created INTEGER DEFAULT CURRENT_TIMESTAMP,
    action TEXT,
    table_name TEXT,
    obj_id INTEGER,
    oldvals TEXT
);
`;

export function justCreateBackupTable(db: Db) { db.exec(JUST_INSERT_TABLE); }

export function makeBackupTriggers(db: Db, table: string, ignoreColumns: Set<string> = new Set()) {
  const sql = `
${JUST_INSERT_TABLE}

-- Clear triggers
DROP TRIGGER IF EXISTS $TABLE_track_insert;
DROP TRIGGER IF EXISTS $TABLE_track_update;
DROP TRIGGER IF EXISTS $TABLE_track_delete;

-- Insert Trigger
CREATE TRIGGER $TABLE_track_insert
AFTER INSERT ON $TABLE
BEGIN
  INSERT INTO _change_log (action, table_name, obj_id)
  VALUES ('INSERT', '$TABLE', NEW.id);
END;

-- Update Trigger
CREATE TRIGGER $TABLE_track_update
AFTER UPDATE ON $TABLE
BEGIN
  INSERT INTO _change_log (action, table_name, obj_id, oldvals)
  SELECT
    'UPDATE', '$TABLE', OLD.id, changes
  FROM
    (SELECT
      json_group_object(col, oldval) AS changes
    FROM
      (SELECT
        json_extract(value, '$[0]') as col,
        json_extract(value, '$[1]') as oldval,
        json_extract(value, '$[2]') as newval
      FROM
        json_each(
          json_array(
            $JSON_ARRAYS_OLD_NEW
          )
        )
      WHERE oldval IS NOT newval
      )
    );
END;

-- Delete Trigger
CREATE TRIGGER $TABLE_track_delete
AFTER DELETE ON $TABLE
BEGIN
  INSERT INTO _change_log (action, table_name, obj_id, oldvals)
  SELECT
    'DELETE', '$TABLE', OLD.id, changes
  FROM
    (SELECT
      json_group_object(col, oldval) AS changes
    FROM
      (SELECT
        json_extract(value, '$[0]') as col,
        json_extract(value, '$[1]') as oldval,
        json_extract(value, '$[2]') as newval
      FROM
        json_each(
          json_array(
            $JSON_ARRAYS_OLD_NULL
          )
        )
      WHERE oldval IS NOT newval
      )
    );
END;
`;
  const cols = columns(db, table).filter(col => !ignoreColumns.has(col));
  const JSON_ARRAYS_OLD_NEW = cols.map(c => `json_array('${c}', OLD.${c}, NEW.${c})`).join(',\n');
  const JSON_ARRAYS_OLD_NULL = cols.map(c => `json_array('${c}', OLD.${c}, null)`).join(',\n');
  const ret = sql.replace(/\$TABLE/g, table)
                  .replace(/\$JSON_ARRAYS_OLD_NEW/g, JSON_ARRAYS_OLD_NEW)
                  .replace(/\$JSON_ARRAYS_OLD_NULL/g, JSON_ARRAYS_OLD_NULL);
  db.exec(ret);
}
