const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_SESSION_BYTES = 16384;
const MAX_METADATA_BYTES = 4096;

function encode(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decode(value) {
  const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), item => item.charCodeAt(0));
}

function required(value, error, maximum = 4096) {
  const result = String(value || "").trim();
  if (!result || result.length > maximum) throw new Error(error);
  return result;
}

function timestamp(value, error) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(error);
  return Number(value);
}

function metadata(value) {
  const email = String(value?.email || "").trim().toLowerCase();
  const name = String(value?.name || "").trim().slice(0, 160);
  const provider = value?.provider === "legacy-mail" || value?.provider === "cheaply-auth" ? value.provider : "unknown";
  const picture = String(value?.picture || "").trim().slice(0, 1000);
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || !name) throw new Error("invalid_profile_metadata");
  return picture ? { email, name, provider, picture } : { email, name, provider };
}

async function aes(secret) {
  const raw = decode(secret);
  if (raw.byteLength !== 32) throw new Error("profile_vault_key_not_configured");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function hmacKey(secret) {
  const raw = decode(secret);
  if (raw.byteLength < 32) throw new Error("profile_vault_hmac_not_configured");
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function digest(key, value) {
  return encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function seal(key, value, maximum) {
  const plain = encoder.encode(JSON.stringify(value));
  if (plain.byteLength > maximum) throw new Error("profile_vault_payload_too_large");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return encode(iv) + "." + encode(cipher);
}

async function open(key, value, maximum) {
  const [iv, cipher, extra] = String(value || "").split(".");
  if (!iv || !cipher || extra) return null;
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, key, decode(cipher)));
    return plain.byteLength <= maximum ? JSON.parse(decoder.decode(plain)) : null;
  } catch { return null; }
}

function identifier() { return encode(crypto.getRandomValues(new Uint8Array(24))); }

export function createCarrierProfileSessionVault(db, options) {
  const encryptionKey = aes(String(options?.encryptionKey || ""));
  const browserKey = hmacKey(String(options?.hmacKey || ""));
  const browserDigest = async value => digest(await browserKey, "carrier-profile-browser:" + required(value, "invalid_profile_browser"));
  const decryptMetadata = async value => {
    try { return metadata(await open(await encryptionKey, value, MAX_METADATA_BYTES)); } catch { return null; }
  };
  return {
    async save(input) { const browser = required(input?.browserId, "invalid_profile_browser"); const subject = required(input?.subjectId, "invalid_profile_subject"); const session = required(input?.session, "invalid_profile_session", MAX_SESSION_BYTES); const now = timestamp(input?.now, "invalid_profile_time"); const expiresAt = timestamp(input?.expiresAt, "invalid_profile_expiry"); if (expiresAt <= now) throw new Error("expired_profile_session"); const profile = metadata(input?.metadata); const [key, device, account] = await Promise.all([encryptionKey, browserDigest(browser), digest(await browserKey, "carrier-profile-subject:" + subject)]); const [sessionCiphertext, metadataCiphertext] = await Promise.all([seal(key, session, MAX_SESSION_BYTES), seal(key, profile, MAX_METADATA_BYTES)]); try { await db.prepare("INSERT INTO carrier_profile_sessions (id,browser_digest,subject_digest,session_ciphertext,metadata_ciphertext,expires_at,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(browser_digest,subject_digest) WHERE revoked_at IS NULL DO UPDATE SET session_ciphertext=excluded.session_ciphertext,metadata_ciphertext=excluded.metadata_ciphertext,expires_at=excluded.expires_at,last_used_at=NULL").bind(identifier(), device, account, sessionCiphertext, metadataCiphertext, expiresAt, now).run(); } catch (error) { if (String(error).includes("profile_limit_reached")) throw new Error("profile_limit_reached"); throw error; } const stored = await db.prepare("SELECT id FROM carrier_profile_sessions WHERE browser_digest = ? AND subject_digest = ? AND revoked_at IS NULL LIMIT 1").bind(device, account).first(); if (!stored?.id) throw new Error("profile_session_write_failed"); return { id: String(stored.id), expiresAt, metadata: profile }; }, async list(input) {
      const now = timestamp(input?.now, "invalid_profile_time");
      const device = await browserDigest(input?.browserId);
      const result = await db.prepare("SELECT id,metadata_ciphertext,expires_at FROM carrier_profile_sessions WHERE browser_digest = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC, created_at DESC LIMIT 5").bind(device, now).all();
      const profiles = [];
      for (const row of result?.results || []) { const profile = await decryptMetadata(row.metadata_ciphertext); if (profile && Number.isSafeInteger(row.expires_at)) profiles.push({ id: String(row.id), expiresAt: Number(row.expires_at), metadata: profile }); }
      return profiles;
    },
    async activate(input) {
      const now = timestamp(input?.now, "invalid_profile_time");
      const id = required(input?.id, "invalid_profile_id", 128);
      const device = await browserDigest(input?.browserId);
      const row = await db.prepare("SELECT id,session_ciphertext,metadata_ciphertext,expires_at FROM carrier_profile_sessions WHERE id = ? AND browser_digest = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1").bind(id, device, now).first();
      if (!row) return null;
      const [session, profile] = await Promise.all([open(await encryptionKey, row.session_ciphertext, MAX_SESSION_BYTES), decryptMetadata(row.metadata_ciphertext)]);
      if (!session || !profile) return null;
      await db.prepare("UPDATE carrier_profile_sessions SET last_used_at = ? WHERE id = ? AND browser_digest = ? AND revoked_at IS NULL").bind(now, id, device).run();
      return { id, expiresAt: Number(row.expires_at), session, metadata: profile };
    },
    async remove(input) {
      const id = required(input?.id, "invalid_profile_id", 128);
      if (id === required(input?.activeId, "invalid_profile_id", 128)) return false;
      const now = timestamp(input?.now, "invalid_profile_time");
      const device = await browserDigest(input?.browserId);
      const result = await db.prepare("UPDATE carrier_profile_sessions SET revoked_at = ? WHERE id = ? AND browser_digest = ? AND revoked_at IS NULL").bind(now, id, device).run();
      return Number(result?.meta?.changes || 0) === 1;
    },
  };
}
