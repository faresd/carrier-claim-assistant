import test from "node:test";
import assert from "node:assert/strict";
import { createCarrierProfileSessionVault, ensureCarrierProfileVaultSchema } from "../src/profile-session-vault.mjs";

const key = Buffer.alloc(32, 3).toString("base64url");
const hmacKey = Buffer.alloc(32, 5).toString("base64url");

class MemoryD1 {
  rows = new Map();
  statements = [];
  prepare = sql => {
    let args = [];
    const statement = {
      bind: (...values) => { args = values; return statement; },
      run: async () => {
        this.statements.push(sql);
        if (sql.startsWith("INSERT INTO carrier_profile_sessions")) {
          const [id, browser, subject, session, metadata, expiresAt, createdAt] = args;
          this.rows.set(id, { id, browser_digest: browser, subject_digest: subject, session_ciphertext: session, metadata_ciphertext: metadata, expires_at: expiresAt, created_at: createdAt, revoked_at: null });
        } else if (sql.startsWith("UPDATE carrier_profile_sessions SET revoked_at")) {
          const [now, id, browser] = args;
          const row = this.rows.get(id);
          const changed = Boolean(row && row.browser_digest === browser && row.revoked_at === null);
          if (changed) row.revoked_at = now;
          return { meta: { changes: changed ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      },
      all: async () => {
        const [browser, now] = args;
        return { results: [...this.rows.values()].filter(row => row.browser_digest === browser && row.revoked_at === null && row.expires_at > now).map(row => ({ id: row.id, metadata_ciphertext: row.metadata_ciphertext, expires_at: row.expires_at })) };
      },
      first: async () => {
        const [id, browser, now] = args;
        const row = this.rows.get(id);
        return row && row.browser_digest === browser && row.revoked_at === null && row.expires_at > now ? row : null;
      },
    };
    return statement;
  };
}

function vault(db) { return createCarrierProfileSessionVault(db, { encryptionKey: key, hmacKey }); }

test("vault stores encrypted browser-bound records and does not expose session material in lists", async () => {
  const db = new MemoryD1();
  await ensureCarrierProfileVaultSchema(db);
  assert.equal(db.statements.length, 3);
  const store = vault(db);
  const saved = await store.save({ browserId: "browser-a", subjectId: "subject-a", session: "secret-session", metadata: { email: "person@cheaply.fr", name: "Person", provider: "legacy-mail" }, expiresAt: 2000, now: 1000 });
  const raw = db.rows.get(saved.id);
  assert.ok(raw);
  assert.doesNotMatch(raw.session_ciphertext, /secret-session/);
  assert.doesNotMatch(raw.metadata_ciphertext, /person@cheaply\.fr/);
  assert.deepEqual(await store.list({ browserId: "browser-b", now: 1200 }), []);
  assert.deepEqual(await store.list({ browserId: "browser-a", now: 1200 }), [{ id: saved.id, expiresAt: 2000, metadata: { email: "person@cheaply.fr", name: "Person", provider: "legacy-mail" } }]);
  assert.equal(await store.activate({ browserId: "browser-b", id: saved.id, now: 1200 }), null);
  assert.equal((await store.activate({ browserId: "browser-a", id: saved.id, now: 1200 })).session, "secret-session");
});

test("vault never removes an active record and rejects another browser", async () => {
  const db = new MemoryD1();
  const store = vault(db);
  const first = await store.save({ browserId: "browser-a", subjectId: "first", session: "one", metadata: { email: "one@cheaply.fr", name: "One", provider: "legacy-mail" }, expiresAt: 2000, now: 1000 });
  const second = await store.save({ browserId: "browser-a", subjectId: "second", session: "two", metadata: { email: "two@cheaply.fr", name: "Two", provider: "cheaply-auth" }, expiresAt: 2000, now: 1000 });
  assert.equal(await store.remove({ browserId: "browser-a", id: first.id, activeId: first.id, now: 1200 }), false);
  assert.equal(await store.remove({ browserId: "browser-b", id: second.id, activeId: first.id, now: 1200 }), false);
  assert.equal(await store.remove({ browserId: "browser-a", id: second.id, activeId: first.id, now: 1200 }), true);
  assert.deepEqual((await store.list({ browserId: "browser-a", now: 1200 })).map(item => item.id), [first.id]);
});
