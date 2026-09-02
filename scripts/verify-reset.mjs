#!/usr/bin/env node
// Prove scripts/reset-database.sql works, WITHOUT destroying anything.
//
// Runs the wipe inside a transaction, counts what would be left, then ROLLS
// BACK. TRUNCATE is transactional in Postgres, so this exercises the real
// statement — including every FK and trigger that could block it — and leaves
// the database exactly as it was.
//
//   DB_URL=postgresql://... node scripts/verify-reset.mjs
import { readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DB_URL;
if (!url) { console.error("DB_URL is not set"); process.exit(1); }

const TABLES = [
  "schools", "students", "payments", "payment_events", "class_fees",
  "student_charges", "student_enrolments", "sessions", "terms",
  "school_admins", "school_settlement", "profiles",
];

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const counts = async () => {
  const out = {};
  for (const t of TABLES) {
    try {
      const r = await client.query(`select count(*)::int n from public.${t}`);
      out[t] = r.rows[0].n;
    } catch { out[t] = "-"; }
  }
  return out;
};

const before = await counts();
console.log("\nBEFORE");
for (const [t, n] of Object.entries(before)) console.log(`  ${t.padEnd(22)} ${n}`);

await client.query("begin");
let ok = true;
try {
  await client.query(readFileSync("scripts/reset-database.sql", "utf8"));
  const after = await counts();
  console.log("\nAFTER (inside the transaction)");
  for (const [t, n] of Object.entries(after)) console.log(`  ${t.padEnd(22)} ${n}`);
} catch (e) {
  ok = false;
  console.error("\nFAILED:", e.message);
} finally {
  await client.query("rollback");
}

const restored = await counts();
const same = JSON.stringify(before) === JSON.stringify(restored);
console.log(`\nrolled back, data ${same ? "restored intact" : "DIFFERS — investigate"}`);
console.log(ok && same ? "RESULT: the reset script works.\n" : "RESULT: problem above.\n");
await client.end();
process.exit(ok && same ? 0 : 1);
