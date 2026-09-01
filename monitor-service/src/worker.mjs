import { dashboardAdminAuth, handleDashboardAuth, validDashboardCsrf } from "./auth.mjs";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const TERMINAL_STATES = new Set(["delivered", "resolved"]);
const TRACKING_STATES = new Set(["unknown", "in_transit", "returning", "pickup_ready", "lost", "damaged", "delivered", "resolved"]);
const CLAIM_REASONS = new Set(["lost", "returned", "delayed", "damaged", "delivered_missing", "contents_missing", "other"]);
const CLAIM_STATUSES = new Set(["none", "requested", "sent"]);
const DASHBOARD_ORIGIN = "https://tracking.cheaply.fr";
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const REQUIRED_SCHEMA_TABLES = [
  "orders", "seller_accounts", "tracking_events", "monitor_runs", "monitor_jobs",
  "devices", "pairing_codes", "pairing_attempts", "claim_launches", "notification_receipts", "deleted_orders"
];
const CLAIM_URLS = {
  laposte: "https://contact.aide.laposte.fr/kb/guide/fr/formulaire-courrier-colis-55CJ9A5dgN/Steps/4901506",
  chronopost: "https://www.chronopost.fr/service-client-en-ligne/home/iv4.html?lang=fr_FR"
};

export function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function classifyTrackingState(statusText, summaryText = "") {
  const current = normalize(statusText);
  const all = normalize(`${statusText || ""} ${summaryText || ""}`);
  const returnPattern = /retour(?:ne|nee|ne)?(?:\s+|.*\s)a l'expediteur|retour expediteur|renvoye a l'expediteur|returned to sender|return to sender|retour de votre envoi/;
  const futureReturnPattern = /(?:sera|serait|pourra|pourrait|va|doit|devra) (?:etre )?(?:retourne|renvoye) a l'expediteur|(?:sans|faute de|a defaut de|en l'absence de) (?:votre )?retrait.*(?:retour|expediteur)|passe ce delai.*(?:retour|expediteur)/;
  const returnContext = (returnPattern.test(current) && !futureReturnPattern.test(current)) ||
    (returnPattern.test(all) && !futureReturnPattern.test(all));
  const senderPickup = /mis(?:e)? a disposition de l'expediteur|disponible pour l'expediteur|expediteur.*(?:retirer|retrait|disponible)|retour.*(?:a retirer|disponible|point de retrait|bureau de poste|agence)/.test(current);
  const pickup = /(?:disponible|vous attend|a retirer|en attente de retrait|mis(?:e)? a disposition).*(?:point de retrait|bureau de poste|agence|relais|site de retrait)|(?:point de retrait|bureau de poste|agence|relais).*(?:disponible|vous attend|a retirer|retrait)/.test(current);
  const lostPattern = /perdu|introuvable|egare|lost|missing|recherche infructueuse|ne peut (?:plus )?etre localise/;
  const damagedPattern = /endommage|deteriore|avarie|damaged|damage/;
  const delivered = /(?:^|\b)(?:a (?:bien )?ete|est) livre\b|livraison (?:a ete )?effectuee|remis au destinataire|^livre\b|\bdelivered\b/.test(current) &&
    !/non livre|pas livre|jamais livre|impossible de livrer|n'a pas pu.*remis|n'avons pu.*remettre|echec de livraison|tentative de livraison/.test(current);

  if (senderPickup || (returnContext && pickup)) return "pickup_ready";
  if (delivered) return "delivered";
  if (lostPattern.test(current)) return "lost";
  if (damagedPattern.test(current)) return "damaged";
  if (returnContext) return "returning";
  if (lostPattern.test(all)) return "lost";
  if (damagedPattern.test(all)) return "damaged";
  if (/acheminement|en transit|in transit|pris en charge|en cours de livraison|distribution|douane|customs/.test(all)) return "in_transit";
  return "unknown";
}

function clean(value, maximum = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function sanitizeJson(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") return clean(value, 5000);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeJson(item, depth + 1));
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).slice(0, 100)
    .filter(([key]) => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key))
    .map(([key, item]) => [key, sanitizeJson(item, depth + 1)]));
}

function claimPayloadJson(input) {
  const payload = input?.claimPayload && typeof input.claimPayload === "object" ? input.claimPayload : {};
  const serialized = JSON.stringify(sanitizeJson(payload));
  return serialized.length <= 30000 ? serialized : "{}";
}

function parsedJsonObject(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeClaimValue(previous, incoming) {
  if (incoming == null || incoming === "") return previous;
  if (Array.isArray(incoming)) return incoming.length ? incoming : previous;
  if (typeof incoming !== "object") return incoming;
  const before = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(incoming)])]
    .map((key) => [key, mergeClaimValue(before[key], incoming[key])])
    .filter(([, value]) => value !== undefined));
}

function mergeClaimPayloadJson(previous, incoming) {
  const merged = sanitizeJson(mergeClaimValue(parsedJsonObject(previous), parsedJsonObject(incoming)));
  const serialized = JSON.stringify(merged || {});
  return serialized.length <= 30000 ? serialized : String(previous || "{}");
}

function safeAmazonOrderUrl(value, orderId) {
  try {
    const url = new URL(clean(value, 1000), "https://sellercentral.amazon.fr");
    if (url.origin !== "https://sellercentral.amazon.fr" || url.pathname !== `/orders-v3/order/${orderId}`) return "";
    url.hash = "";
    return url.toString().slice(0, 1000);
  } catch {
    return "";
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

export async function monitorHealth(env = {}, request = new Request(`${DASHBOARD_ORIGIN}/api/health`)) {
  const bindingsReady = typeof env.DB?.prepare === "function" &&
    typeof env.TRACKING_QUEUE?.send === "function" &&
    typeof env.ASSETS?.fetch === "function" &&
    Boolean(clean(env.LAPOSTE_OKAPI_KEY, 500)) &&
    Boolean(clean(env.SESSION_SECRET, 500)) &&
    Boolean(clean(env.TRACKING_CLIENT_SECRET, 500));
  if (!bindingsReady) {
    return json({ ok: false, service: "carrier-return-monitor", ready: false }, 503, corsHeaders(request));
  }
  try {
    const names = REQUIRED_SCHEMA_TABLES.map((name) => `'${name}'`).join(",");
    const result = await env.DB.prepare(`SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type = 'table' AND name IN (${names})`).first();
    if (Number(result?.table_count || 0) !== REQUIRED_SCHEMA_TABLES.length) {
      return json({ ok: false, service: "carrier-return-monitor", ready: false }, 503, corsHeaders(request));
    }
  } catch {
    return json({ ok: false, service: "carrier-return-monitor", ready: false }, 503, corsHeaders(request));
  }
  return json({ ok: true, service: "carrier-return-monitor", ready: true }, 200, corsHeaders(request));
}

function secureAssetHeaders(headers) {
  const next = new Headers(headers);
  next.set("content-security-policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'");
  next.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  next.set("referrer-policy", "no-referrer");
  next.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  next.set("x-content-type-options", "nosniff");
  next.set("x-frame-options", "DENY");
  return next;
}

function bearer(request) {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || "";
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pairingCodeKey(code, env) {
  const secret = String(env.SESSION_SECRET || "");
  if (!secret) throw new Error("Pairing is temporarily unavailable.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`carrier-pairing:${code}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function extensionAuthorized(request, env) {
  const token = bearer(request);
  if (!token) return { authorized: false, deviceId: "" };
  const tokenHash = await sha256(token);
  const device = await env.DB.prepare("SELECT id FROM devices WHERE token_hash = ? AND revoked_at = ''").bind(tokenHash).first();
  if (!device) return { authorized: false, deviceId: "" };
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(new Date().toISOString(), device.id).run();
  return { authorized: true, deviceId: device.id };
}

export function allowedApiOrigin(request) {
  const origin = clean(request.headers.get("origin"), 300);
  if (origin === DASHBOARD_ORIGIN || EXTENSION_ORIGIN.test(origin)) return origin;
  return "";
}

function corsHeaders(request) {
  const origin = allowedApiOrigin(request);
  return {
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-csrf-token",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function safeOrder(input = {}, now = new Date().toISOString()) {
  const orderId = clean(input.orderId, 40);
  const accountId = clean(input.sellerAccountId || input.accountId || "default", 180);
  const marketplaceId = clean(input.marketplaceId || "A13V1IB3VIYZZH", 180);
  const requestedTrackingState = clean(input.trackingState || "unknown", 30);
  const trackingState = requestedTrackingState === "resolved" ? "unknown" : requestedTrackingState;
  const claimReason = clean(input.claimReason || "none", 50);
  const claimStatus = clean(input.claimStatus || "none", 30);
  return {
    recordId: `${accountId}|${marketplaceId}|${orderId}`,
    accountId,
    accountName: clean(input.sellerAccountName || input.accountName || accountId, 160),
    marketplaceId,
    orderId,
    trackingNumber: clean(input.trackingNumber, 40).toUpperCase(),
    carrierId: clean(input.carrierId, 30),
    carrierLabel: clean(input.carrierLabel || input.carrier, 80),
    amazonUrl: safeAmazonOrderUrl(input.sourceUrl || input.amazonUrl, orderId),
    shipDate: clean(input.shipDate, 100),
    deliverBy: clean(input.deliverBy, 180),
    itemValue: clean(input.itemValue, 80),
    productName: clean(input.productName, 500),
    recipientName: clean(input.recipientName, 200),
    recipientAddress1: clean(input.recipientAddress1, 250),
    recipientAddress2: clean(input.recipientAddress2, 250),
    recipientCity: clean(input.recipientCity, 120),
    recipientPostalCode: clean(input.recipientPostalCode, 30),
    recipientCountry: clean(input.recipientCountry, 100),
    trackingState: TRACKING_STATES.has(trackingState) ? trackingState : "unknown",
    statusText: clean(input.statusText, 1000),
    statusSummary: clean(input.statusSummary, 5000),
    checkedAt: clean(input.checkedAt, 40),
    claimRecommended: input.claimRecommended ? 1 : 0,
    claimReason: claimReason === "none" || CLAIM_REASONS.has(claimReason) ? claimReason : "other",
    claimTitle: clean(input.claimTitle, 250),
    claimStatus: CLAIM_STATUSES.has(claimStatus) ? claimStatus : "none",
    claimReference: clean(input.claimReference, 80),
    claimSubmittedAt: clean(input.claimSubmittedAt, 40),
    claimPayload: claimPayloadJson(input),
    pickupNotifiedAt: clean(input.pickupNotifiedAt, 40),
    resolvedAt: "",
    resolutionNote: "",
    firstSeenAt: clean(input.firstSeenAt || now, 40),
    updatedAt: now
  };
}

export async function upsertOrder(db, input) {
  const order = safeOrder(input);
  if (!/^[0-9]{3}-[0-9]{7}-[0-9]{7}$/.test(order.orderId) || !order.trackingNumber) {
    throw new Error("A valid Amazon order ID and tracking number are required.");
  }
  const fallbackAccounts = new Set(["default", "sellercentral.amazon.fr"]);
  const tombstone = fallbackAccounts.has(order.accountId)
    ? await db.prepare("SELECT record_id FROM deleted_orders WHERE order_id = ? AND marketplace_id = ? LIMIT 1")
      .bind(order.orderId, order.marketplaceId).first()
    : await db.prepare(`SELECT record_id FROM deleted_orders
      WHERE marketplace_id = ? AND order_id = ? AND (account_id = ? OR account_id IN ('default', 'sellercentral.amazon.fr')) LIMIT 1`)
      .bind(order.marketplaceId, order.orderId, order.accountId).first();
  if (tombstone) {
    const error = new Error("This resolved order was permanently deleted from the return monitor.");
    error.status = 410;
    throw error;
  }
  let migratedFallbackAccount = "";
  const existingAccountOrder = await db.prepare(`SELECT record_id, account_id FROM orders
    WHERE order_id = ? AND marketplace_id = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .bind(order.orderId, order.marketplaceId, order.accountId).first();
  if (existingAccountOrder?.record_id) {
    order.recordId = existingAccountOrder.record_id;
  } else if (!fallbackAccounts.has(order.accountId)) {
    const fallback = await db.prepare(`SELECT record_id, account_id FROM orders
      WHERE order_id = ? AND marketplace_id = ? AND account_id IN ('default', 'sellercentral.amazon.fr')
      ORDER BY updated_at DESC LIMIT 1`).bind(order.orderId, order.marketplaceId).first();
    if (fallback?.record_id && fallback.record_id !== order.recordId) {
      order.recordId = fallback.record_id;
      migratedFallbackAccount = fallback.account_id;
    }
  }
  const existingPayload = await db.prepare("SELECT claim_payload FROM orders WHERE record_id = ?").bind(order.recordId).first();
  order.claimPayload = mergeClaimPayloadJson(existingPayload?.claim_payload, order.claimPayload);
  await db.prepare(`
    INSERT INTO orders (
      record_id, account_id, account_name, marketplace_id, order_id, tracking_number, carrier_id, carrier_label, amazon_url, ship_date, deliver_by, item_value,
      product_name, recipient_name, recipient_address1, recipient_address2, recipient_city,
      recipient_postal_code, recipient_country, tracking_state, status_text, status_summary, checked_at,
      claim_recommended, claim_reason, claim_title, claim_status, claim_reference, claim_submitted_at, claim_payload,
      pickup_notified_at, resolved_at, resolution_note, first_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      account_id = excluded.account_id,
      account_name = CASE WHEN excluded.account_name != '' THEN excluded.account_name ELSE orders.account_name END,
      marketplace_id = excluded.marketplace_id,
      tracking_number = excluded.tracking_number,
      carrier_id = CASE WHEN excluded.carrier_id != '' THEN excluded.carrier_id ELSE orders.carrier_id END,
      carrier_label = CASE WHEN excluded.carrier_label != '' THEN excluded.carrier_label ELSE orders.carrier_label END,
      amazon_url = CASE WHEN excluded.amazon_url != '' THEN excluded.amazon_url ELSE orders.amazon_url END,
      ship_date = CASE WHEN excluded.ship_date != '' THEN excluded.ship_date ELSE orders.ship_date END,
      deliver_by = CASE WHEN excluded.deliver_by != '' THEN excluded.deliver_by ELSE orders.deliver_by END,
      item_value = CASE WHEN excluded.item_value != '' THEN excluded.item_value ELSE orders.item_value END,
      product_name = CASE WHEN excluded.product_name != '' THEN excluded.product_name ELSE orders.product_name END,
      recipient_name = CASE WHEN excluded.recipient_name != '' THEN excluded.recipient_name ELSE orders.recipient_name END,
      recipient_address1 = CASE WHEN excluded.recipient_address1 != '' THEN excluded.recipient_address1 ELSE orders.recipient_address1 END,
      recipient_address2 = CASE WHEN excluded.recipient_address2 != '' THEN excluded.recipient_address2 ELSE orders.recipient_address2 END,
      recipient_city = CASE WHEN excluded.recipient_city != '' THEN excluded.recipient_city ELSE orders.recipient_city END,
      recipient_postal_code = CASE WHEN excluded.recipient_postal_code != '' THEN excluded.recipient_postal_code ELSE orders.recipient_postal_code END,
      recipient_country = CASE WHEN excluded.recipient_country != '' THEN excluded.recipient_country ELSE orders.recipient_country END,
      tracking_state = CASE
        WHEN orders.tracking_state IN ('delivered', 'resolved') THEN orders.tracking_state
        WHEN orders.checked_at != '' AND (excluded.checked_at = '' OR excluded.checked_at < orders.checked_at) THEN orders.tracking_state
        WHEN excluded.tracking_state = 'unknown' AND orders.tracking_state != 'unknown' THEN orders.tracking_state
        ELSE excluded.tracking_state
      END,
      status_text = CASE
        WHEN orders.tracking_state IN ('delivered', 'resolved') THEN orders.status_text
        WHEN excluded.status_text = '' THEN orders.status_text
        WHEN orders.checked_at != '' AND (excluded.checked_at = '' OR excluded.checked_at < orders.checked_at) THEN orders.status_text
        ELSE excluded.status_text
      END,
      status_summary = CASE
        WHEN orders.tracking_state IN ('delivered', 'resolved') THEN orders.status_summary
        WHEN excluded.status_summary = '' THEN orders.status_summary
        WHEN orders.checked_at != '' AND (excluded.checked_at = '' OR excluded.checked_at < orders.checked_at) THEN orders.status_summary
        ELSE excluded.status_summary
      END,
      checked_at = CASE
        WHEN orders.tracking_state IN ('delivered', 'resolved') THEN orders.checked_at
        WHEN excluded.checked_at = '' THEN orders.checked_at
        WHEN orders.checked_at = '' OR excluded.checked_at >= orders.checked_at THEN excluded.checked_at
        ELSE orders.checked_at
      END,
      claim_recommended = MAX(orders.claim_recommended, excluded.claim_recommended),
      claim_reason = CASE WHEN excluded.claim_reason != 'none' THEN excluded.claim_reason ELSE orders.claim_reason END,
      claim_title = CASE WHEN excluded.claim_title != '' THEN excluded.claim_title ELSE orders.claim_title END,
      claim_status = CASE WHEN excluded.claim_status != 'none' THEN excluded.claim_status ELSE orders.claim_status END,
      claim_reference = CASE WHEN excluded.claim_reference != '' THEN excluded.claim_reference ELSE orders.claim_reference END,
      claim_submitted_at = CASE WHEN excluded.claim_submitted_at != '' THEN excluded.claim_submitted_at ELSE orders.claim_submitted_at END,
      claim_payload = CASE WHEN excluded.claim_payload != '{}' THEN excluded.claim_payload ELSE orders.claim_payload END,
      pickup_notified_at = CASE WHEN excluded.pickup_notified_at != '' THEN excluded.pickup_notified_at ELSE orders.pickup_notified_at END,
      resolved_at = CASE WHEN excluded.resolved_at != '' THEN excluded.resolved_at ELSE orders.resolved_at END,
      resolution_note = CASE WHEN excluded.resolution_note != '' THEN excluded.resolution_note ELSE orders.resolution_note END,
      updated_at = excluded.updated_at
  `).bind(
    order.recordId, order.accountId, order.accountName, order.marketplaceId, order.orderId,
    order.trackingNumber, order.carrierId, order.carrierLabel, order.amazonUrl, order.shipDate,
    order.deliverBy, order.itemValue, order.productName, order.recipientName, order.recipientAddress1,
    order.recipientAddress2, order.recipientCity, order.recipientPostalCode, order.recipientCountry,
    order.trackingState, order.statusText, order.statusSummary, order.checkedAt, order.claimRecommended,
    order.claimReason, order.claimTitle, order.claimStatus, order.claimReference, order.claimSubmittedAt, order.claimPayload,
    order.pickupNotifiedAt, order.resolvedAt, order.resolutionNote, order.firstSeenAt, order.updatedAt
  ).run();
  await db.prepare(`INSERT INTO seller_accounts (account_id, account_name, marketplace_id, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, marketplace_id) DO UPDATE SET account_name = excluded.account_name, updated_at = excluded.updated_at`)
    .bind(order.accountId, order.accountName, order.marketplaceId, order.firstSeenAt, order.updatedAt).run();
  if (migratedFallbackAccount) {
    await db.prepare(`DELETE FROM seller_accounts WHERE account_id = ? AND marketplace_id = ?
      AND NOT EXISTS (SELECT 1 FROM orders WHERE account_id = ? AND marketplace_id = ?)`)
      .bind(migratedFallbackAccount, order.marketplaceId, migratedFallbackAccount, order.marketplaceId).run();
  }
  return order;
}

function rowToOrder(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
}

async function listOrders(db, url, deviceId = "master") {
  const view = url.searchParams.get("view") || "all";
  const alerts = url.searchParams.get("alerts") === "1";
  const clauses = [];
  const values = [];
  if (view === "lost") clauses.push("tracking_state IN ('lost', 'damaged')");
  if (view === "returned") clauses.push("tracking_state IN ('returning', 'pickup_ready')");
  if (view === "resolved") clauses.push("tracking_state = 'resolved'");
  if (view === "active") clauses.push("tracking_state NOT IN ('delivered', 'resolved')");
  if (alerts) {
    clauses.push("tracking_state = 'pickup_ready' AND NOT EXISTS (SELECT 1 FROM notification_receipts receipt WHERE receipt.record_id = orders.record_id AND receipt.device_id = ? AND receipt.last_notified_at >= ?)");
    values.push(deviceId, new Date(Date.now() - 20 * 3600000).toISOString());
  }
  const accountId = clean(url.searchParams.get("account"), 180);
  if (accountId) {
    clauses.push("account_id = ?");
    values.push(accountId);
  }
  const orderIds = [...new Set(String(url.searchParams.get("order_ids") || "").split(",")
    .map((value) => clean(value, 40)).filter((value) => /^[0-9]{3}-[0-9]{7}-[0-9]{7}$/.test(value)))].slice(0, 100);
  if (orderIds.length) {
    clauses.push(`order_id IN (${orderIds.map(() => "?").join(",")})`);
    values.push(...orderIds);
  }
  const search = clean(url.searchParams.get("q"), 100);
  if (search) {
    clauses.push("(order_id LIKE ? OR tracking_number LIKE ? OR recipient_name LIKE ?)");
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 200)));
  const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get("offset") || 0)));
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db.prepare(`SELECT * FROM orders ${where} ORDER BY CASE tracking_state WHEN 'pickup_ready' THEN 0 WHEN 'returning' THEN 1 WHEN 'lost' THEN 2 ELSE 3 END, updated_at DESC LIMIT ? OFFSET ?`).bind(...values, limit, offset).all();
  return (result.results || []).map(rowToOrder);
}

async function exportHistoryPage(db, url) {
  const resources = {
    orders: ["orders", "updated_at DESC"],
    trackingEvents: ["tracking_events", "observed_at DESC"],
    sellerAccounts: ["seller_accounts", "updated_at DESC"],
    monitorRuns: ["monitor_runs", "run_date DESC"]
  };
  const resource = clean(url.searchParams.get("resource"), 40);
  const definition = resources[resource];
  if (!definition) throw new Error("Choose a valid export resource.");
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 500)));
  const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get("offset") || 0)));
  const result = await db.prepare(`SELECT * FROM ${definition[0]} ORDER BY ${definition[1]} LIMIT ? OFFSET ?`)
    .bind(limit, offset).all();
  const rows = (result.results || []).map((row) => {
    const normalized = rowToOrder(row);
    if (resource === "orders") normalized.claimPayload = parsedJsonObject(normalized.claimPayload);
    return normalized;
  });
  return { resource, rows, hasMore: rows.length === limit };
}

async function deleteResolvedOrder(env, recordId) {
  const row = await env.DB.prepare("SELECT record_id, account_id, marketplace_id, order_id, tracking_state FROM orders WHERE record_id = ?")
    .bind(recordId).first();
  if (!row) throw new Error("Tracked order not found.");
  if (row.tracking_state !== "resolved") throw new Error("Only a resolved order can be permanently deleted.");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO deleted_orders (account_id, marketplace_id, order_id, record_id, deleted_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, marketplace_id, order_id) DO UPDATE SET
      record_id = excluded.record_id, deleted_at = excluded.deleted_at`)
      .bind(row.account_id, row.marketplace_id, row.order_id, row.record_id, new Date().toISOString()),
    env.DB.prepare("DELETE FROM notification_receipts WHERE record_id = ?").bind(recordId),
    env.DB.prepare("DELETE FROM claim_launches WHERE record_id = ?").bind(recordId),
    env.DB.prepare("DELETE FROM tracking_events WHERE record_id = ?").bind(recordId),
    env.DB.prepare("DELETE FROM monitor_jobs WHERE record_id = ?").bind(recordId),
    env.DB.prepare("DELETE FROM orders WHERE record_id = ? AND tracking_state = 'resolved'").bind(recordId),
    env.DB.prepare(`DELETE FROM seller_accounts WHERE account_id = ? AND marketplace_id = ?
      AND NOT EXISTS (SELECT 1 FROM orders WHERE account_id = ? AND marketplace_id = ?)`)
      .bind(row.account_id, row.marketplace_id, row.account_id, row.marketplace_id)
  ]);
  return { recordId };
}

function eventList(payload) {
  const shipment = payload?.shipment || payload?.data?.shipment || payload?.data || payload || {};
  const candidates = [shipment.event, shipment.events, payload?.events, payload?.event]
    .flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
  return { shipment, events: candidates };
}

export function normalizeCarrierPayload(payload) {
  const { shipment, events } = eventList(payload);
  const eventMessage = (event) => clean(event?.label || event?.labelShort || event?.message || event?.libelle || event?.description, 1000);
  const eventDate = (event) => clean(event?.date || event?.eventDate || event?.dateHeure || event?.timestamp, 80);
  const sorted = [...events].sort((a, b) => new Date(eventDate(b) || 0) - new Date(eventDate(a) || 0));
  const latest = sorted[0] || shipment;
  const messages = sorted.map(eventMessage).filter(Boolean);
  const statusText = eventMessage(latest) || clean(shipment?.message || payload?.message, 1000);
  const statusSummary = messages.join(" · ").slice(0, 5000) || statusText;
  return {
    statusText,
    statusSummary,
    eventAt: eventDate(latest),
    rawCode: clean(latest?.code || latest?.status || shipment?.status || payload?.status, 80),
    trackingState: classifyTrackingState(statusText, statusSummary)
  };
}

export async function fetchOfficialTracking(trackingNumber, env, fetchImpl = fetch) {
  if (!env.LAPOSTE_OKAPI_KEY) throw new Error("LAPOSTE_OKAPI_KEY is not configured.");
  const endpoint = `https://api.laposte.fr/suivi/v2/idships/${encodeURIComponent(trackingNumber)}?lang=fr_FR`;
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json", "X-Okapi-Key": env.LAPOSTE_OKAPI_KEY }
  });
  if (!response.ok) throw new Error(`La Poste Suivi returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload?.returnCode && Number(payload.returnCode) !== 200) throw new Error(clean(payload.returnMessage || `Carrier error ${payload.returnCode}`, 300));
  return normalizeCarrierPayload(payload);
}

function parisDateParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function shouldRunMorningMonitor(date = new Date()) {
  return parisDateParts(date).hour === "07";
}

async function sendMonitorJobs(env, jobs, runDate) {
  for (let index = 0; index < jobs.length; index += 100) {
    const chunk = jobs.slice(index, index + 100);
    await env.TRACKING_QUEUE.sendBatch(chunk.map((job) => ({
      body: { runDate, recordId: job.record_id || job.recordId }
    })));
    const dispatchedAt = new Date().toISOString();
    await env.DB.batch(chunk.map((job) => env.DB.prepare(`UPDATE monitor_jobs SET status = 'dispatched', updated_at = ?
      WHERE run_date = ? AND record_id = ? AND status = 'queued'`)
      .bind(dispatchedAt, runDate, job.record_id || job.recordId)));
  }
}

export async function enqueueDailyMonitor(env, date = new Date()) {
  const parts = parisDateParts(date);
  const runDate = `${parts.year}-${parts.month}-${parts.day}`;
  const existing = await env.DB.prepare("SELECT * FROM monitor_runs WHERE run_date = ?").bind(runDate).first();
  if (existing?.completed_at) return { skipped: true, reason: "already-run", runDate };
  if (existing) {
    const pending = (await env.DB.prepare("SELECT record_id FROM monitor_jobs WHERE run_date = ? AND status = 'queued'").bind(runDate).all()).results || [];
    await sendMonitorJobs(env, pending, runDate);
    return { skipped: false, resumed: true, runDate, queuedCount: pending.length };
  }
  const startedAt = date.toISOString();
  const rows = (await env.DB.prepare("SELECT record_id FROM orders WHERE tracking_state NOT IN ('delivered', 'resolved') ORDER BY checked_at ASC").all()).results || [];
  await env.DB.prepare("INSERT INTO monitor_runs (run_date, started_at, completed_at, queued_count) VALUES (?, ?, ?, ?)")
    .bind(runDate, startedAt, rows.length ? "" : startedAt, rows.length).run();
  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100);
    await env.DB.batch(chunk.map((row) => env.DB.prepare(`INSERT INTO monitor_jobs
      (run_date, record_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'queued', 0, ?, ?)`)
      .bind(runDate, row.record_id, startedAt, startedAt)));
    await sendMonitorJobs(env, chunk, runDate);
  }
  return { skipped: false, runDate, queuedCount: rows.length };
}

async function finishMonitorJob(env, job, { row = null, result = null, error = "" } = {}) {
  const now = new Date().toISOString();
  const failed = Boolean(error);
  const statements = [];
  if (row && result) {
    const state = row.tracking_state === "resolved"
      ? "resolved"
      : result.trackingState === "unknown" && row.tracking_state !== "unknown"
        ? row.tracking_state
        : result.trackingState;
    statements.push(
      env.DB.prepare(`UPDATE orders SET tracking_state = ?, status_text = ?, status_summary = ?, checked_at = ?, updated_at = ? WHERE record_id = ?`)
        .bind(state, result.statusText, result.statusSummary, now, now, row.record_id),
      env.DB.prepare(`INSERT OR IGNORE INTO tracking_events (record_id, tracking_state, status_text, event_at, observed_at, raw_code) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(row.record_id, state, result.statusText, result.eventAt, now, result.rawCode)
    );
  }
  statements.push(
    env.DB.prepare("UPDATE monitor_jobs SET status = ?, last_error = ?, updated_at = ? WHERE run_date = ? AND record_id = ?")
      .bind(failed ? "failed" : "completed", clean(error, 500), now, job.run_date, job.record_id),
    env.DB.prepare(`UPDATE monitor_runs SET
      processed_count = processed_count + 1,
      checked_count = checked_count + ?,
      error_count = error_count + ?,
      completed_at = CASE WHEN processed_count + 1 >= queued_count THEN ? ELSE completed_at END
      WHERE run_date = ?`).bind(result ? 1 : 0, failed ? 1 : 0, now, job.run_date)
  );
  await env.DB.batch(statements);
}

export async function processTrackingMessage(message, env, { fetchImpl = fetch } = {}) {
  const runDate = clean(message.body?.runDate, 20);
  const recordId = clean(message.body?.recordId, 500);
  const job = await env.DB.prepare("SELECT * FROM monitor_jobs WHERE run_date = ? AND record_id = ?").bind(runDate, recordId).first();
  if (!job || ["completed", "failed"].includes(job.status)) {
    message.ack();
    return;
  }
  const attempt = Number(job.attempts || 0) + 1;
  await env.DB.prepare("UPDATE monitor_jobs SET attempts = ?, updated_at = ? WHERE run_date = ? AND record_id = ?")
    .bind(attempt, new Date().toISOString(), runDate, recordId).run();
  const row = await env.DB.prepare("SELECT * FROM orders WHERE record_id = ?").bind(recordId).first();
  if (!row || TERMINAL_STATES.has(row.tracking_state)) {
    await finishMonitorJob(env, job);
    message.ack();
    return;
  }
  try {
    const result = await fetchOfficialTracking(row.tracking_number, env, fetchImpl);
    await finishMonitorJob(env, job, { row, result });
    message.ack();
  } catch (error) {
    if (attempt < 4) {
      await env.DB.prepare("UPDATE monitor_jobs SET status = 'retrying', last_error = ?, updated_at = ? WHERE run_date = ? AND record_id = ?")
        .bind(clean(error.message, 500), new Date().toISOString(), runDate, recordId).run();
      message.retry({ delaySeconds: 600 });
      return;
    }
    await finishMonitorJob(env, job, { row, error: error.message });
    message.ack();
  }
}

async function mutateOrder(request, env, recordId, action, deviceId = "master") {
  const now = new Date().toISOString();
  const body = await request.json().catch(() => ({}));
  if (action === "resolve") {
    await env.DB.prepare("UPDATE orders SET resolution_previous_state = CASE WHEN tracking_state = 'resolved' THEN resolution_previous_state ELSE tracking_state END, tracking_state = 'resolved', resolved_at = ?, resolution_note = ?, updated_at = ? WHERE record_id = ?")
      .bind(now, clean(body.note || "Returned parcel physically received", 500), now, recordId).run();
  } else if (action === "reopen") {
    await env.DB.prepare("UPDATE orders SET tracking_state = COALESCE(NULLIF(resolution_previous_state, ''), 'returning'), resolution_previous_state = '', resolved_at = '', resolution_note = '', updated_at = ? WHERE record_id = ?")
      .bind(now, recordId).run();
  } else if (action === "claim") {
    const reason = CLAIM_REASONS.has(body.reason) ? body.reason : "other";
    await env.DB.prepare("UPDATE orders SET claim_status = 'requested', claim_reason = ?, claim_recommended = 1, updated_at = ? WHERE record_id = ?")
      .bind(reason, now, recordId).run();
  } else if (action === "ack-pickup") {
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET pickup_ack_at = ?, pickup_notified_at = CASE WHEN pickup_notified_at = '' THEN ? ELSE pickup_notified_at END, updated_at = ? WHERE record_id = ?")
        .bind(now, now, now, recordId),
      env.DB.prepare("INSERT INTO notification_receipts (record_id, device_id, last_notified_at) VALUES (?, ?, ?) ON CONFLICT(record_id, device_id) DO UPDATE SET last_notified_at = excluded.last_notified_at")
        .bind(recordId, deviceId, now)
    ]);
  }
  return rowToOrder(await env.DB.prepare("SELECT * FROM orders WHERE record_id = ?").bind(recordId).first());
}

function parsedClaimPayload(row) {
  try {
    const payload = JSON.parse(row?.claim_payload || "{}");
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

async function createClaimLaunch(request, env, recordId) {
  const row = await env.DB.prepare("SELECT * FROM orders WHERE record_id = ?").bind(recordId).first();
  if (!row) throw new Error("Tracked order not found.");
  const carrier = row.carrier_id === "chronopost" || /chrono/i.test(row.carrier_label) ? "chronopost" : "laposte";
  const body = await request.json().catch(() => ({}));
  const payload = parsedClaimPayload(row);
  const reason = CLAIM_REASONS.has(body.reason) ? body.reason : CLAIM_REASONS.has(row.claim_reason) ? row.claim_reason : "other";
  payload.carrier = carrier;
  payload.reason = reason;
  payload.details = clean(body.details || payload.details || row.claim_title || `Commande Amazon ${row.order_id} · ${row.status_text}`, 500);
  payload.recipientTitle = clean(body.recipientTitle || payload.recipientTitle, 30);
  payload.executionMode = "automatic";
  payload.order = {
    ...(payload.order || {}),
    sourceUrl: row.amazon_url,
    orderId: row.order_id,
    trackingNumber: row.tracking_number,
    shipDate: row.ship_date,
    deliverBy: row.deliver_by,
    itemValue: row.item_value,
    productName: row.product_name,
    recipientName: row.recipient_name,
    recipientAddress1: row.recipient_address1,
    recipientAddress2: row.recipient_address2,
    recipientCity: row.recipient_city,
    recipientPostalCode: row.recipient_postal_code,
    recipientCountry: row.recipient_country,
    sellerAccountId: row.account_id,
    sellerAccountName: row.account_name,
    marketplaceId: row.marketplace_id
  };
  const sender = payload.sender || {};
  const required = [
    ["sender email", sender.email], ["sender phone", sender.phone],
    ["sender name/company", sender.contactFirstName || sender.contactLastName || sender.companyName],
    ["sender address", sender.address1], ["sender postal code", sender.postalCode], ["sender city", sender.city],
    ["recipient name", payload.order.recipientName], ["recipient address", payload.order.recipientAddress1],
    ["recipient postal code", payload.order.recipientPostalCode], ["recipient city", payload.order.recipientCity],
    ["recipient country", payload.order.recipientCountry]
  ].filter(([, value]) => !clean(value)).map(([label]) => label);
  if (carrier === "laposte" && !payload.recipientTitle) required.push("recipient title");
  if (required.length) throw new Error(`Complete the claim package first: ${required.join(", ")}.`);

  const now = new Date();
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const expiresAt = new Date(now.getTime() + 10 * 60000).toISOString();
  const serialized = JSON.stringify(sanitizeJson(payload));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM claim_launches WHERE expires_at < ? OR used_at != ''").bind(now.toISOString()),
    env.DB.prepare("INSERT INTO claim_launches (token_hash, record_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), recordId, now.toISOString(), expiresAt),
    env.DB.prepare("UPDATE orders SET claim_status = 'requested', claim_reason = ?, claim_recommended = 1, claim_payload = ?, updated_at = ? WHERE record_id = ?")
      .bind(reason, serialized, now.toISOString(), recordId)
  ]);
  return { url: `${CLAIM_URLS[carrier]}#carrier-claim-launch=${token}`, expiresAt, carrier };
}

async function redeemClaimLaunch(request, env) {
  const body = await request.json().catch(() => ({}));
  const token = clean(body.token, 160);
  if (!token) throw new Error("The cloud claim link is missing.");
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`SELECT orders.*, claim_launches.expires_at AS launch_expires_at, claim_launches.used_at AS launch_used_at
    FROM claim_launches JOIN orders ON orders.record_id = claim_launches.record_id WHERE claim_launches.token_hash = ?`).bind(tokenHash).first();
  if (!row || row.launch_used_at || new Date(row.launch_expires_at) <= new Date()) throw new Error("This claim link is invalid, expired, or already used.");
  await env.DB.prepare("UPDATE claim_launches SET used_at = ? WHERE token_hash = ?").bind(new Date().toISOString(), tokenHash).run();
  const payload = parsedClaimPayload(row);
  const carrier = row.carrier_id === "chronopost" || /chrono/i.test(row.carrier_label) ? "chronopost" : "laposte";
  return {
    ...payload,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    carrier,
    executionMode: "automatic",
    sourceTabId: null,
    order: { ...(payload.order || {}), orderId: row.order_id, trackingNumber: row.tracking_number, sourceUrl: row.amazon_url }
  };
}

async function createPairingCode(request, env) {
  const body = await request.json().catch(() => ({}));
  const now = new Date();
  const code = String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
  const expiresAt = new Date(now.getTime() + 10 * 60000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at < ? OR used_at != ''").bind(now.toISOString()),
    env.DB.prepare("DELETE FROM pairing_attempts WHERE updated_at < ?").bind(new Date(now.getTime() - 86400000).toISOString())
  ]);
  await env.DB.prepare("INSERT INTO pairing_codes (code, device_name, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await pairingCodeKey(code, env), clean(body.deviceName || "New Chrome/Brave browser", 100), now.toISOString(), expiresAt).run();
  return { code, expiresAt };
}

async function claimPairingCode(request, env) {
  const body = await request.json().catch(() => ({}));
  const code = clean(body.code, 6);
  const now = new Date();
  const origin = request.headers.get("origin") || "";
  if (!EXTENSION_ORIGIN.test(origin)) throw new Error("Pairing is only available from the Chrome/Brave extension.");
  const remoteAddress = request.headers.get("cf-connecting-ip") || "unknown";
  const windowNumber = Math.floor(now.getTime() / (15 * 60000));
  const attemptKey = await sha256(`pairing:${remoteAddress}:${windowNumber}`);
  await env.DB.prepare(`INSERT INTO pairing_attempts (attempt_key, attempt_count, window_started_at, updated_at)
    VALUES (?, 1, ?, ?) ON CONFLICT(attempt_key) DO UPDATE SET attempt_count = attempt_count + 1, updated_at = excluded.updated_at`)
    .bind(attemptKey, new Date(windowNumber * 15 * 60000).toISOString(), now.toISOString()).run();
  const attempts = await env.DB.prepare("SELECT attempt_count FROM pairing_attempts WHERE attempt_key = ?").bind(attemptKey).first();
  if (Number(attempts?.attempt_count || 0) > 10) throw new Error("Too many pairing attempts. Wait fifteen minutes and try again.");
  const storedCode = await pairingCodeKey(code, env);
  const pairing = await env.DB.prepare("SELECT * FROM pairing_codes WHERE code = ? AND used_at = ''")
    .bind(storedCode).first();
  if (!pairing || new Date(pairing.expires_at) <= now) throw new Error("Pairing code is invalid or expired.");
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const deviceId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .bind(deviceId, clean(body.deviceName || pairing.device_name, 100), await sha256(token), now.toISOString(), now.toISOString()),
    env.DB.prepare("UPDATE pairing_codes SET used_at = ? WHERE code = ?").bind(now.toISOString(), pairing.code)
  ]);
  return { token, deviceId, deviceName: clean(body.deviceName || pairing.device_name, 100) };
}

async function api(request, env, url) {
  const adminAuth = await dashboardAdminAuth(request, env);
  const isAdmin = adminAuth.authorized;
  if (url.pathname === "/api/pairing/claim" && request.method === "POST") {
    try {
      return json({ ok: true, ...(await claimPairingCode(request, env)) }, 200, corsHeaders(request));
    } catch (error) {
      return json({ error: error.message }, 400, corsHeaders(request));
    }
  }
  const extensionAuth = await extensionAuthorized(request, env);
  const isExtension = extensionAuth.authorized;
  if (!isAdmin && !isExtension) return json({ error: "Unauthorized" }, 401, corsHeaders(request));
  if (isAdmin && !isExtension && request.method !== "GET" && !(await validDashboardCsrf(request, adminAuth, env))) {
    return json({ error: "Invalid or missing CSRF token" }, 403, corsHeaders(request));
  }

  if (url.pathname === "/api/claim-launch/redeem" && request.method === "POST") {
    if (!isExtension) return json({ error: "Paired browser token required" }, 403, corsHeaders(request));
    try {
      return json({ ok: true, claim: await redeemClaimLaunch(request, env) }, 200, corsHeaders(request));
    } catch (error) {
      return json({ error: error.message }, 400, corsHeaders(request));
    }
  }

  if (url.pathname === "/api/pairing" && request.method === "POST") {
    if (!isAdmin) return json({ error: "Dashboard administrator access required" }, 403, corsHeaders(request));
    return json({ ok: true, ...(await createPairingCode(request, env)) }, 200, corsHeaders(request));
  }

  if (url.pathname === "/api/devices" && request.method === "GET") {
    if (!isAdmin) return json({ error: "Dashboard administrator access required" }, 403, corsHeaders(request));
    const result = await env.DB.prepare(`SELECT id, name, created_at, last_seen_at, revoked_at
      FROM devices ORDER BY CASE WHEN revoked_at = '' THEN 0 ELSE 1 END, last_seen_at DESC`).all();
    return json({ devices: (result.results || []).map(rowToOrder) }, 200, corsHeaders(request));
  }
  const deviceMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/);
  if (deviceMatch && request.method === "POST") {
    if (!isAdmin) return json({ error: "Dashboard administrator access required" }, 403, corsHeaders(request));
    const deviceId = decodeURIComponent(deviceMatch[1]);
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").bind(now, deviceId).run();
    return json({ ok: true }, 200, corsHeaders(request));
  }

  if (url.pathname === "/api/orders" && request.method === "GET") {
    const orders = await listOrders(env.DB, url, extensionAuth.deviceId || "admin");
    return json({ orders, hasMore: orders.length === Math.min(500, Number(url.searchParams.get("limit") || 200)), serverTime: new Date().toISOString() }, 200, corsHeaders(request));
  }
  if (url.pathname === "/api/orders" && ["POST", "PUT"].includes(request.method)) {
    try {
      const order = await upsertOrder(env.DB, await request.json());
      return json({ ok: true, order }, 200, corsHeaders(request));
    } catch (error) {
      return json({ error: error.message, ...(error.status === 410 ? { deleted: true } : {}) }, error.status || 400, corsHeaders(request));
    }
  }
  if (url.pathname === "/api/export" && request.method === "GET") {
    if (!isAdmin) return json({ error: "Dashboard administrator access required" }, 403, corsHeaders(request));
    try {
      return json({ ok: true, ...(await exportHistoryPage(env.DB, url)), exportedAt: new Date().toISOString() }, 200, corsHeaders(request));
    } catch (error) {
      return json({ error: error.message }, 400, corsHeaders(request));
    }
  }
  const eventsMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/events$/);
  if (eventsMatch && request.method === "GET") {
    const recordId = decodeURIComponent(eventsMatch[1]);
    const result = await env.DB.prepare(`SELECT tracking_state, status_text, event_at, observed_at, raw_code
      FROM tracking_events WHERE record_id = ? ORDER BY COALESCE(NULLIF(event_at, ''), observed_at) DESC LIMIT 100`)
      .bind(recordId).all();
    return json({ events: (result.results || []).map(rowToOrder) }, 200, corsHeaders(request));
  }
  const launchMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/launch-claim$/);
  if (launchMatch && request.method === "POST") {
    if (!isAdmin) return json({ error: "Dashboard administrator access required" }, 403, corsHeaders(request));
    try {
      return json({ ok: true, ...(await createClaimLaunch(request, env, decodeURIComponent(launchMatch[1]))) }, 200, corsHeaders(request));
    } catch (error) {
      return json({ error: error.message }, 400, corsHeaders(request));
    }
  }
  const deleteMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/delete$/);
  if (deleteMatch && request.method === "POST") {
    if (!isAdmin) return json({ error: "Dashboard administrator access required" }, 403, corsHeaders(request));
    try {
      return json({ ok: true, ...(await deleteResolvedOrder(env, decodeURIComponent(deleteMatch[1]))) }, 200, corsHeaders(request));
    } catch (error) {
      return json({ error: error.message }, 400, corsHeaders(request));
    }
  }
  const actionMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/(resolve|reopen|claim|ack-pickup)$/);
  if (actionMatch && request.method === "POST") {
    const recordId = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    if (action !== "ack-pickup" && !isAdmin) return json({ error: "Dashboard administrator access required" }, 403, corsHeaders(request));
    return json({ ok: true, order: await mutateOrder(request, env, recordId, action, extensionAuth.deviceId || "admin") }, 200, corsHeaders(request));
  }
  if (url.pathname === "/api/monitor/run" && request.method === "POST") {
    if (!isAdmin) return json({ error: "Dashboard administrator access required" }, 403, corsHeaders(request));
    return json(await enqueueDailyMonitor(env), 200, corsHeaders(request));
  }
  return json({ error: "Not found" }, 404, corsHeaders(request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      if (request.headers.get("origin") && !allowedApiOrigin(request)) {
        return new Response(null, { status: 403, headers: { vary: "Origin" } });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (url.pathname === "/api/health") return monitorHealth(env, request);
    const authResponse = await handleDashboardAuth(request, env, url);
    if (authResponse) return authResponse;
    if (url.pathname.startsWith("/api/")) return api(request, env, url);
    const asset = await env.ASSETS.fetch(request);
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers: secureAssetHeaders(asset.headers) });
  },
  async scheduled(_event, env, ctx) {
    if (!shouldRunMorningMonitor(new Date())) return;
    ctx.waitUntil(enqueueDailyMonitor(env));
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      await processTrackingMessage(message, env);
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }
};
