import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqlDurableStore } from "../dist/durable.js";
import {
  assertDurableResume,
  assertExclusiveAcquire,
  assertJournalRoundTrip,
} from "./durable-store-contract.mjs";

// An in-memory SQLite database is the executor under test for the sqlite
// dialect. For postgres there is no server here, so the executor asserts the
// $1…$n grammar this store must emit and then translates it back — which is
// exactly the part of the postgres path that is this store's responsibility.
function sqlExecutor(dialect) {
  const db = new DatabaseSync(":memory:");
  db.exec(SqlDurableStore.schema(dialect));
  const seen = [];
  return {
    db,
    seen,
    executor: {
      exec(sql, params) {
        seen.push(sql);
        if (dialect === "postgres") {
          assert.equal(/\?/.test(sql), false, `postgres query kept a ? placeholder: ${sql}`);
          if (params.length > 0) {
            assert.equal(sql.includes("$1"), true, `postgres query lost its placeholders: ${sql}`);
          }
        }
        const portable = dialect === "postgres" ? sql.replace(/\$\d+/g, "?") : sql;
        return db.prepare(portable).all(...params);
      },
    },
  };
}

function store(dialect, options = {}) {
  const { executor, db, seen } = sqlExecutor(dialect);
  return { store: new SqlDurableStore({ sql: executor, dialect, ...options }), db, seen };
}

test("schema names both tables and refuses an unsafe table name", () => {
  const ddl = SqlDurableStore.schema("sqlite", "custom_journal");
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS custom_journal \(/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS custom_journal_leases \(/);
  // The table name is interpolated, never bound, so it is validated instead.
  assert.throws(
    () => SqlDurableStore.schema("sqlite", "journal; DROP TABLE users"),
    /cave_durable_sql_table_invalid/,
  );
  assert.throws(
    () => new SqlDurableStore({ sql: { exec: () => [] }, dialect: "sqlite", table: "a-b" }),
    /cave_durable_sql_table_invalid/,
  );
  assert.throws(
    () => new SqlDurableStore({ sql: { exec: () => [] }, dialect: "mysql" }),
    /cave_durable_sql_dialect_unsupported/,
  );
});

for (const dialect of ["sqlite", "postgres"]) {
  test(`${dialect}: appends load back in order and every run is listable`, async () => {
    const scenario = store(dialect);
    await assertJournalRoundTrip(scenario.store);
  });

  test(`${dialect}: one driver at a time, across two store instances`, async () => {
    const { executor } = sqlExecutor(dialect);
    const first = new SqlDurableStore({ sql: executor, dialect });
    const second = new SqlDurableStore({ sql: executor, dialect });
    await assertExclusiveAcquire(first, second);
  });

  test(`${dialect}: a crashed run resumes from its last completed turn`, async () => {
    const scenario = store(dialect);
    await assertDurableResume(scenario.store, `sql-${dialect}-resume`);
  });
}

test("an expired lease is reaped by the next acquirer, a live one is not", async () => {
  const { executor, db } = sqlExecutor("sqlite");
  const holder = new SqlDurableStore({ sql: executor, dialect: "sqlite", leaseTtlMs: 3_000 });
  const other = new SqlDurableStore({ sql: executor, dialect: "sqlite", leaseTtlMs: 3_000 });
  await holder.acquire("expiring");
  await assert.rejects(other.acquire("expiring"), /cave_durable_run_locked/);
  // Age the lease rather than sleeping through its TTL: expiry is a stored
  // timestamp, so moving it is the whole of what "expired" means here.
  db.prepare("UPDATE caveman_durable_journal_leases SET expires_at = ? WHERE run_id = ?")
    .run(Date.now() - 1, "expiring");
  const release = await other.acquire("expiring");
  assert.equal(typeof release, "function");
  // Exactly one lease row survives a takeover.
  const rows = db.prepare("SELECT run_id FROM caveman_durable_journal_leases").all();
  assert.equal(rows.length, 1);
  await release();
  await holder.close("expiring");
  await other.close("expiring");
});
