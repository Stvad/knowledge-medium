import {DatabaseSync, type SQLInputValue} from 'node:sqlite'
import {expect, it} from 'vitest'
import type {BridgeClient} from '../src/client.js'
import {createBridgeGraph} from '../src/graph.js'

it('reads exact live ids and scopes them to the supplied workspace', async () => {
  using db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE blocks (id, workspace_id, deleted, properties_json, user_updated_at, updated_at);
    INSERT INTO blocks VALUES
      ('here', 'a', 0, '{}', 2, 3), ('there', 'b', 0, '{}', 1, 1),
      ('gone', 'a', 1, '{}', 0, 0), ('unrequested', 'a', 0, '{}', 0, 0);`)
  const graph = createBridgeGraph({
    runCommand: async ({sql, params}: {sql: string, params: SQLInputValue[]}) => db.prepare(sql).all(...params),
  } as BridgeClient)
  const ids = ['here', 'there', 'gone', 'missing']
  expect([...(await graph.blockViews(ids, 'a')).keys()]).toEqual(['here'])
  expect([...(await graph.blockViews(ids)).keys()]).toEqual(['here', 'there'])
})
