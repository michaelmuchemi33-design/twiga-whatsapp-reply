import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENWA_BASE_URL = (process.env.OPENWA_BASE_URL || "").replace(/\/+$/, "");
const OPENWA_API_KEY = process.env.OPENWA_API_KEY || "";
const OPENWA_WEBHOOK_SECRET = process.env.OPENWA_WEBHOOK_SECRET || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const XAI_MODEL = process.env.XAI_MODEL || "grok-3-mini";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "twiga-product-images";
const DASHBOARD_ORIGINS = (process.env.DASHBOARD_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
const DEFAULT_REPLY_PROMPT = process.env.DEFAULT_REPLY_PROMPT ||
  "You are TWIGA, a helpful WhatsApp receptionist for this business in Kenya. Reply naturally, warmly and concisely. Use clear English; understand Kiswahili and Sheng and reply in the language the customer uses. Never invent prices, stock, order status, appointment availability, policies or promises. If information is missing, ask one clear question or say a staff member will confirm. Never ask for passwords, PINs, OTPs or payment credentials. Never initiate calls. Do not send marketing messages unless the customer has explicitly opted in.";

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "OPENWA_BASE_URL", "OPENWA_API_KEY", "OPENWA_WEBHOOK_SECRET"];
for (const key of required) if (!process.env[key]) console.error("Missing required environment variable:", key);

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
};
const readBody = async (req, max = 1024 * 1024) => {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error("Request body too large"); chunks.push(chunk); }
  return Buffer.concat(chunks);
};
const parseJson = raw => raw.length ? JSON.parse(raw.toString("utf8")) : {};
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a || "")); const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const supaHeaders = (key = SUPABASE_SERVICE_ROLE_KEY) => ({ apikey: key, authorization: "Bearer " + key, "content-type": "application/json" });
async function supa(path, options = {}) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + path, { ...options, headers: { ...supaHeaders(), ...(options.headers || {}) } });
  const body = await response.text();
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + body.slice(0, 500));
  return body ? JSON.parse(body) : null;
}
function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function r2Hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}
function presignR2(method, objectKey, contentType = "", expiresSeconds = 900) {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw Object.assign(new Error("Cloudflare R2 is not configured on the TWIGA service"), { status: 503 });
  }
  const host = R2_ACCOUNT_ID + ".r2.cloudflarestorage.com";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = dateStamp + "/auto/s3/aws4_request";
  const canonicalUri = "/" + awsEncode(R2_BUCKET) + "/" + objectKey.split("/").map(awsEncode).join("/");
  const signedHeaders = method === "PUT" ? "content-type;host" : "host";
  const params = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", R2_ACCESS_KEY_ID + "/" + scope],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresSeconds)],
    ["X-Amz-SignedHeaders", signedHeaders]
  ].sort((a, b) => awsEncode(a[0]).localeCompare(awsEncode(b[0])));
  const canonicalQuery = params.map(([k, v]) => awsEncode(k) + "=" + awsEncode(v)).join("&");
  const canonicalHeaders = (method === "PUT" ? "content-type:" + contentType + "\n" : "") + "host:" + host + "\n";
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const kDate = r2Hmac(Buffer.from("AWS4" + R2_SECRET_ACCESS_KEY), dateStamp);
  const kRegion = r2Hmac(kDate, "auto");
  const kService = r2Hmac(kRegion, "s3");
  const kSigning = r2Hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return "https://" + host + canonicalUri + "?" + canonicalQuery + "&X-Amz-Signature=" + signature;
}
async function authUser(token) {
  const response = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON_KEY, authorization: "Bearer " + token } });
  if (!response.ok) return null;
  return response.json();
}
function bearer(req) { const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || ""); return m?.[1]; }
async function requireBusiness(req, businessId) {
  const token = bearer(req);
  if (!token) throw Object.assign(new Error("Sign in required"), { status: 401 });
  const user = await authUser(token);
  if (!user?.id) throw Object.assign(new Error("Invalid or expired sign-in"), { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(String(businessId || ""))) throw Object.assign(new Error("A valid businessId is required"), { status: 400 });
  const members = await supa("business_members?select=business_id,role&business_id=eq." + encodeURIComponent(businessId) + "&user_id=eq." + encodeURIComponent(user.id) + "&limit=1");
  if (!members?.length) throw Object.assign(new Error("You do not have access to this business"), { status: 403 });
  const businesses = await supa("businesses?select=id,name,business_type,status&id=eq." + encodeURIComponent(businessId) + "&limit=1");
  if (!businesses?.length || businesses[0].status === "suspended") throw Object.assign(new Error("Business is unavailable"), { status: 403 });
  return { user, business: businesses[0] };
}
async function openwa(path, method = "GET", body) {
  if (!OPENWA_BASE_URL || !OPENWA_API_KEY) throw new Error("OpenWA is not configured");
  const url = OPENWA_BASE_URL + (path.startsWith("/api/") ? path : "/api" + path);
  const response = await fetch(url, { method, headers: { "x-api-key": OPENWA_API_KEY, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw Object.assign(new Error("WhatsApp gateway " + response.status + ": " + (data.message || data.error || text.slice(0, 250))), { status: response.status, details: data });
  return data;
}
async function getConnection(businessId) {
  const rows = await supa("twiga_whatsapp_connections?select=*&business_id=eq." + encodeURIComponent(businessId) + "&limit=1");
  return rows?.[0] || null;
}
async function saveConnection(row) {
  return supa("twiga_whatsapp_connections?on_conflict=business_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row)
  });
}
async function updateConnection(businessId, patch) {
  return supa("twiga_whatsapp_connections?business_id=eq." + encodeURIComponent(businessId), {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
}
const waSessionName = businessId => "twiga-" + String(businessId).replace(/-/g, "").slice(0, 32);
const toChatId = raw => {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits ? digits + "@c.us" : null;
};
async function recordMessage(row) {
  const result = await supa("twiga_whatsapp_messages?on_conflict=session_id,message_id", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(row)
  });
  return Array.isArray(result) && result.length > 0;
}
async function getBusinessKnowledge(businessId) {
  const [profiles, products] = await Promise.all([
    supa("twiga_business_profiles?select=business_summary,what_they_sell,what_they_do,products_and_services,target_customers,unique_selling_points,service_area,opening_hours,delivery_and_payment,returns_and_refunds,frequently_asked_questions,brand_voice,reply_language,assistant_instructions&business_id=eq." + encodeURIComponent(businessId) + "&limit=1"),
    supa("twiga_products?select=name,description,category,price,currency,unit,stock_quantity,is_active&business_id=eq." + encodeURIComponent(businessId) + "&is_active=eq.true&order=name.asc&limit=40")
  ]);
  return { profile: profiles?.[0] || null, products: (products || []).map(p => ({
    name: p.name, description: p.description, category: p.category, price: p.price,
    currency: p.currency, unit: p.unit, available: Number(p.stock_quantity || 0) > 0
  })) };
}
async function xaiReply(business, message, history = [], knowledge = { profile: null, products: [] }) {
  if (!XAI_API_KEY) throw new Error("XAI_API_KEY is not configured");
  const system = [
    DEFAULT_REPLY_PROMPT,
    "Business name: " + (business.name || "the business"),
    "Business type: " + (business.business_type || "local business"),
    "Business-specific WhatsApp instructions: " + (business.whatsapp_prompt || "No additional instructions."),
    "Business profile facts (owner-provided): " + JSON.stringify(knowledge.profile || {}),
    "Active product catalogue (business-scoped): " + JSON.stringify(knowledge.products || []),
    "Reply language preference: " + (knowledge.profile?.reply_language || "match_customer"),
    "Brand voice: " + (knowledge.profile?.brand_voice || "warm, helpful and professional"),
    "Additional assistant instructions: " + (knowledge.profile?.assistant_instructions || ""),
    "Rules: Answer only the customer's latest question using the supplied business context. Treat business profile and catalogue as the source of truth. Do not invent prices, stock, product features, opening hours or policies; if the catalogue has no match, ask one short question or offer staff follow-up. Never reveal cost prices, internal IDs or private staff notes. Never claim an order was created, paid, dispatched, or an appointment booked unless the context explicitly confirms it. Do not send more than one short reply. If the customer asks for a human, acknowledge and say a team member will follow up."
  ].join("\n\n");
  const messages = [{ role: "system", content: system }, ...history.filter(x => ["system","assistant","user"].includes(x.role) && x.content).slice(-10), { role: "user", content: message }];
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + XAI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: XAI_MODEL, messages, temperature: 0.35, max_tokens: 220 }),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("xAI API " + response.status + ": " + JSON.stringify(result).slice(0, 300));
  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("xAI returned an empty reply");
  return text.slice(0, 1800);
}
async function customerContext(businessId, phone, sessionId, chatId) {
  const [customers, history] = await Promise.all([
    phone ? supa("twiga_customers?select=id,name,phone&business_id=eq." + encodeURIComponent(businessId) + "&phone=eq." + encodeURIComponent(phone) + "&limit=1") : Promise.resolve([]),
    supa("twiga_whatsapp_messages?select=message_id,direction,body&business_id=eq." + encodeURIComponent(businessId) + "&session_id=eq." + encodeURIComponent(sessionId) + "&chat_id=eq." + encodeURIComponent(chatId) + "&order=created_at.desc&limit=10")
  ]);
  const customer = customers?.[0];
  let orders = [], appointments = [];
  if (customer) {
    [orders, appointments] = await Promise.all([
      supa("twiga_orders?select=customer_name,total_amount,description,status,created_at&business_id=eq." + encodeURIComponent(businessId) + "&customer_name=eq." + encodeURIComponent(customer.name) + "&order=created_at.desc&limit=5"),
      supa("twiga_appointments?select=customer_name,scheduled_at,notes,status&business_id=eq." + encodeURIComponent(businessId) + "&phone=eq." + encodeURIComponent(phone) + "&order=scheduled_at.desc&limit=5")
    ]);
  }
  const context = { knownCustomer: customer ? { name: customer.name } : null, orders, appointments };
  const prior = (history || []).slice(1, 9).reverse().map(x => ({ role: x.direction === "outbound" ? "assistant" : "user", content: x.body || "" }));
  return [{ role: "system", content: "Verified business records for this sender (do not expose internal IDs): " + JSON.stringify(context) }, ...prior];
}
async function sendText(sessionId, chatId, text) {
  return openwa("/sessions/" + encodeURIComponent(sessionId) + "/messages/send-text", "POST", { chatId, text, linkPreview: false });
}
async function isOptedOut(businessId, phone) {
  if (!phone) return false;
  const rows = await supa("twiga_whatsapp_optouts?select=id&business_id=eq." + encodeURIComponent(businessId) + "&phone=eq." + encodeURIComponent(phone) + "&limit=1");
  return Boolean(rows?.length);
}
async function handleInbound(payload) {
  const data = payload.data || {};
  const sessionId = payload.sessionId;
  const messageId = typeof data.id === "string" ? data.id : (data.id?._serialized || data.id?.id || data.messageId || payload.idempotencyKey);
  const chatId = data.chatId || data.from || data.to;
  const fromMe = data.fromMe === true;
  const body = String(data.body || data.text || "").trim();
  if (!sessionId || !messageId || !chatId || fromMe || !body) return;
  if (!String(chatId).endsWith("@c.us")) return; // no groups, channels, broadcasts or status replies
  const connections = await supa("twiga_whatsapp_connections?select=business_id,ai_enabled,system_prompt,status&session_id=eq." + encodeURIComponent(sessionId) + "&limit=1");
  const connection = connections?.[0];
  if (!connection) return;
  const businessRows = await supa("businesses?select=id,name,business_type,status&id=eq." + encodeURIComponent(connection.business_id) + "&limit=1");
  const business = businessRows?.[0];
  if (!business || business.status === "suspended") return;
  const sender = data.senderPhone || data.from || data.author || chatId;
  const phone = String(sender).replace(/\D/g, "").slice(-15);
  const inserted = await recordMessage({
    business_id: connection.business_id, session_id: sessionId, message_id: String(messageId),
    chat_id: String(chatId), sender_id: String(sender), sender_name: data.contact?.pushName || data.contact?.name || null,
    direction: "inbound", body, status: "received", metadata: { type: data.type || "text", timestamp: payload.timestamp || null }
  });
  if (!inserted) return; // idempotency: never answer the same WhatsApp message twice
  const stop = /^(stop|unsubscribe|opt[\s-]?out|cancel)$/i.test(body);
  const start = /^start$/i.test(body);
  if (stop) {
    await supa("twiga_whatsapp_optouts?on_conflict=business_id,phone", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ business_id: connection.business_id, phone, source: "whatsapp_keyword" })
    });
    await supa("twiga_followups?business_id=eq." + encodeURIComponent(connection.business_id) + "&phone_number=eq." + encodeURIComponent(phone) + "&channel=eq.whatsapp&status=in.(scheduled,in_progress)", {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled", consent_status: "opted_out" })
    }).catch(() => {});
    await sendText(sessionId, chatId, "Understood. We will not send you further WhatsApp follow-ups. Reply START if you want to opt in again.");
    return;
  }
  if (start) {
    await supa("twiga_whatsapp_optouts?business_id=eq." + encodeURIComponent(connection.business_id) + "&phone=eq." + encodeURIComponent(phone), { method: "DELETE", headers: { Prefer: "return=minimal" } });
    await sendText(sessionId, chatId, "Thanks. You have opted back in to WhatsApp messages from this business.");
    return;
  }
  if (!connection.ai_enabled || await isOptedOut(connection.business_id, phone)) return;
  try {
    const [context, knowledge] = await Promise.all([
      customerContext(connection.business_id, phone, sessionId, chatId),
      getBusinessKnowledge(connection.business_id)
    ]);
    const reply = await xaiReply({ ...business, whatsapp_prompt: connection.system_prompt }, body, context, knowledge);
    const sent = await sendText(sessionId, chatId, reply);
    await supa("twiga_whatsapp_messages", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ business_id: connection.business_id, session_id: sessionId, message_id: "reply_" + String(messageId), chat_id: String(chatId), sender_id: "twiga", direction: "outbound", body: reply, status: "sent", metadata: { in_reply_to: String(messageId), provider_message: sent } })
    });
    await supa("twiga_whatsapp_messages?session_id=eq." + encodeURIComponent(sessionId) + "&message_id=eq." + encodeURIComponent(String(messageId)), {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ reply_body: reply, status: "replied" })
    });
  } catch (error) {
    console.error("AI reply failed", { sessionId, messageId: String(messageId), error: error.message });
    await supa("twiga_whatsapp_messages?session_id=eq." + encodeURIComponent(sessionId) + "&message_id=eq." + encodeURIComponent(String(messageId)), {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "reply_failed", error_message: error.message.slice(0, 500) })
    }).catch(() => {});
  }
}
function verifyOpenwa(raw, signature) {
  if (!signature || !OPENWA_WEBHOOK_SECRET) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", OPENWA_WEBHOOK_SECRET).update(raw).digest("hex");
  return safeEqual(signature, expected);
}
async function handleWebhook(req, res) {
  const raw = await readBody(req);
  if (!verifyOpenwa(raw, req.headers["x-openwa-signature"])) return json(res, 401, { error: "Invalid webhook signature" });
  const payload = parseJson(raw);
  if (payload.event === "message.received") {
    await handleInbound(payload);
  } else if (payload.event === "session.status" || payload.event === "session.authenticated" || payload.event === "session.disconnected") {
    const sessionId = payload.sessionId;
    const rawStatus = payload.data?.status || "connecting";
    const status = payload.event === "session.authenticated" || rawStatus === "ready" ? "connected" : payload.event === "session.disconnected" ? "disconnected" : rawStatus;
    if (sessionId) await supa("twiga_whatsapp_connections?session_id=eq." + encodeURIComponent(sessionId), {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status, updated_at: new Date().toISOString() })
    });
  }
  return json(res, 200, { received: true });
}
async function connect(req, res, businessId) {
  const { user, business } = await requireBusiness(req, businessId);
  let connection = await getConnection(businessId);
  if (!connection) {
    const name = waSessionName(businessId);
    const created = await openwa("/sessions", "POST", { name, config: { autoRejectCalls: false } });
    connection = {
      business_id: businessId, session_id: created.id, status: "created", ai_enabled: false,
      system_prompt: "", created_by: user.id, updated_at: new Date().toISOString()
    };
    await saveConnection(connection);
  }
  if (!connection.webhook_id) {
    const hook = await openwa("/sessions/" + encodeURIComponent(connection.session_id) + "/webhooks", "POST", {
      url: process.env.OPENWA_WEBHOOK_URL || (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "") + "/webhooks/openwa",
      events: ["message.received", "session.status", "session.authenticated", "session.disconnected"],
      secret: OPENWA_WEBHOOK_SECRET,
      retryCount: 3
    });
    await updateConnection(businessId, { webhook_id: hook.id, status: "created" });
  }
  try { await openwa("/sessions/" + encodeURIComponent(connection.session_id) + "/start", "POST", {}); }
  catch (e) { if (![400,409].includes(e.status)) throw e; }
  let qr = null;
  try { qr = await openwa("/sessions/" + encodeURIComponent(connection.session_id) + "/qr"); }
  catch (error) { if (![400,409].includes(error.status)) throw error; }
  await updateConnection(businessId, { status: "connecting", business_name: business.name });
  return json(res, qr ? 200 : 202, { businessId, sessionId: connection.session_id, status: "connecting", qr, qrReady: Boolean(qr) });
}
async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const origin = req.headers.origin;
  if (origin && DASHBOARD_ORIGINS.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-headers", "authorization,content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  }
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, service: "twiga-whatsapp-reply", model: XAI_MODEL });
  if (req.method === "POST" && url.pathname === "/webhooks/openwa") return handleWebhook(req, res);
  const businessId = url.searchParams.get("businessId");
  if (req.method === "GET" && url.pathname === "/api/business/profile") {
    const { business } = await requireBusiness(req, businessId);
    const rows = await supa("twiga_business_profiles?select=*&business_id=eq." + encodeURIComponent(business.id) + "&limit=1");
    return json(res, 200, { profile: rows?.[0] || null });
  }
  if (req.method === "PATCH" && url.pathname === "/api/business/profile") {
    const body = parseJson(await readBody(req)); const { user, business } = await requireBusiness(req, body.businessId);
    const fields = ["business_summary","what_they_sell","what_they_do","products_and_services","target_customers","unique_selling_points","service_area","opening_hours","delivery_and_payment","returns_and_refunds","frequently_asked_questions","brand_voice","reply_language","assistant_instructions"];
    const patch = { business_id: business.id, updated_by: user.id, updated_at: new Date().toISOString() };
    for (const key of fields) if (typeof body[key] === "string") patch[key] = body[key].slice(0, key === "assistant_instructions" || key === "frequently_asked_questions" ? 6000 : 3000);
    const rows = await supa("twiga_business_profiles?on_conflict=business_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(patch)
    });
    return json(res, 200, { saved: true, profile: rows?.[0] || patch });
  }
  if (req.method === "GET" && url.pathname === "/api/catalog/products") {
    const { business } = await requireBusiness(req, businessId);
    const rows = await supa("twiga_products?select=id,sku,name,description,category,price,currency,unit,stock_quantity,low_stock_threshold,image_key,barcode,is_active,created_at,updated_at&business_id=eq." + encodeURIComponent(business.id) + "&order=name.asc&limit=200");
    return json(res, 200, { products: rows || [] });
  }
  if (req.method === "POST" && url.pathname === "/api/catalog/products") {
    const body = parseJson(await readBody(req)); const { user, business } = await requireBusiness(req, body.businessId);
    const name = String(body.name || "").trim();
    const price = Number(body.price ?? 0); const stock = Number(body.stock_quantity ?? 0);
    if (!name || name.length > 160 || !Number.isFinite(price) || price < 0 || !Number.isFinite(stock) || stock < 0) return json(res, 400, { error: "A product name and valid non-negative price/stock are required" });
    const imageKey = body.image_key ? String(body.image_key) : null;
    if (imageKey && !imageKey.startsWith("businesses/" + business.id + "/products/")) return json(res, 400, { error: "Product image must belong to this business" });
    const row = {
      business_id: business.id, created_by: user.id, sku: body.sku ? String(body.sku).slice(0,80) : null,
      name, description: String(body.description || "").slice(0,3000), category: String(body.category || "").slice(0,120),
      price, cost_price: body.cost_price === null || body.cost_price === undefined || body.cost_price === "" ? null : Number(body.cost_price),
      currency: String(body.currency || "KES").slice(0,8), unit: String(body.unit || "piece").slice(0,40),
      stock_quantity: stock, low_stock_threshold: Number(body.low_stock_threshold || 0), image_key: imageKey,
      barcode: body.barcode ? String(body.barcode).slice(0,120) : null, is_active: body.is_active !== false
    };
    const rows = await supa("twiga_products", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
    return json(res, 201, { product: rows?.[0] || null });
  }
  if (req.method === "PATCH" && url.pathname === "/api/catalog/products") {
    const body = parseJson(await readBody(req)); const { business } = await requireBusiness(req, body.businessId);
    if (!/^[0-9a-f-]{36}$/i.test(String(body.id || ""))) return json(res, 400, { error: "A valid product id is required" });
    const allowed = ["sku","name","description","category","price","cost_price","currency","unit","stock_quantity","low_stock_threshold","image_key","barcode","is_active"];
    const patch = {};
    for (const key of allowed) if (Object.hasOwn(body, key)) patch[key] = body[key];
    if (patch.image_key && !String(patch.image_key).startsWith("businesses/" + business.id + "/products/")) return json(res, 400, { error: "Product image must belong to this business" });
    patch.updated_at = new Date().toISOString();
    const rows = await supa("twiga_products?id=eq." + encodeURIComponent(body.id) + "&business_id=eq." + encodeURIComponent(business.id), {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch)
    });
    if (!rows?.length) return json(res, 404, { error: "Product not found" });
    return json(res, 200, { product: rows[0] });
  }
  if (req.method === "DELETE" && url.pathname === "/api/catalog/products") {
    const body = parseJson(await readBody(req)); const { business } = await requireBusiness(req, body.businessId);
    if (!/^[0-9a-f-]{36}$/i.test(String(body.id || ""))) return json(res, 400, { error: "A valid product id is required" });
    await supa("twiga_products?id=eq." + encodeURIComponent(body.id) + "&business_id=eq." + encodeURIComponent(business.id), { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return json(res, 200, { deleted: true });
  }
  if (req.method === "POST" && url.pathname === "/api/catalog/upload-url") {
    const body = parseJson(await readBody(req)); const { business } = await requireBusiness(req, body.businessId);
    const allowedTypes = new Set(["image/jpeg","image/png","image/webp"]);
    const contentType = String(body.contentType || "").toLowerCase();
    const sizeBytes = Number(body.sizeBytes || 0);
    if (!allowedTypes.has(contentType) || !Number.isFinite(sizeBytes) || sizeBytes < 1 || sizeBytes > 5 * 1024 * 1024) {
      return json(res, 400, { error: "Choose a JPG, PNG or WebP image up to 5 MB" });
    }
    const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1];
    const key = "businesses/" + business.id + "/products/" + crypto.randomUUID() + "." + extension;
    return json(res, 200, { uploadUrl: presignR2("PUT", key, contentType), imageUrl: presignR2("GET", key), imageKey: key, expiresIn: 900 });
  }
  if (req.method === "GET" && url.pathname === "/api/catalog/image-url") {
    const { business } = await requireBusiness(req, businessId);
    const key = String(url.searchParams.get("key") || "");
    if (!key.startsWith("businesses/" + business.id + "/products/") || key.includes("..")) return json(res, 403, { error: "Image does not belong to this business" });
    return json(res, 200, { imageUrl: presignR2("GET", key), expiresIn: 900 });
  }
  if (req.method === "POST" && url.pathname === "/api/whatsapp/connect") {
    const body = parseJson(await readBody(req)); return connect(req, res, body.businessId);
  }
  if (req.method === "GET" && url.pathname === "/api/whatsapp/status") {
    const { business } = await requireBusiness(req, businessId);
    const connection = await getConnection(business.id);
    if (!connection) return json(res, 200, { connected: false, status: "not_connected" });
    const session = await openwa("/sessions/" + encodeURIComponent(connection.session_id));
    return json(res, 200, { connected: session.status === "ready" || session.status === "connected", status: session.status || connection.status, phone: session.phone || null, aiEnabled: connection.ai_enabled, sessionId: connection.session_id });
  }
  if (req.method === "GET" && url.pathname === "/api/whatsapp/qr") {
    const { business } = await requireBusiness(req, businessId);
    const connection = await getConnection(business.id);
    if (!connection) return json(res, 404, { error: "Connect WhatsApp first" });
    const qr = await openwa("/sessions/" + encodeURIComponent(connection.session_id) + "/qr");
    return json(res, 200, qr);
  }
  if (req.method === "POST" && url.pathname === "/api/whatsapp/disconnect") {
    const body = parseJson(await readBody(req)); const { business } = await requireBusiness(req, body.businessId);
    const connection = await getConnection(business.id);
    if (!connection) return json(res, 404, { error: "No WhatsApp connection" });
    await openwa("/sessions/" + encodeURIComponent(connection.session_id) + "/stop", "POST", {});
    await updateConnection(business.id, { status: "disconnected", ai_enabled: false });
    return json(res, 200, { disconnected: true });
  }
  if (req.method === "PATCH" && url.pathname === "/api/whatsapp/settings") {
    const body = parseJson(await readBody(req)); const { business } = await requireBusiness(req, body.businessId);
    const patch = {};
    if (typeof body.aiEnabled === "boolean") patch.ai_enabled = body.aiEnabled;
    if (typeof body.systemPrompt === "string") patch.system_prompt = body.systemPrompt.slice(0, 4000);
    await updateConnection(business.id, patch);
    return json(res, 200, { saved: true, ...patch });
  }
  if (req.method === "POST" && url.pathname === "/api/whatsapp/send") {
    const body = parseJson(await readBody(req)); const { business } = await requireBusiness(req, body.businessId);
    const connection = await getConnection(business.id);
    const phone = String(body.phone || "").replace(/\D/g, "");
    const message = String(body.message || "").trim();
    if (!connection || connection.status !== "connected") return json(res, 409, { error: "WhatsApp is not connected" });
    if (phone.length < 10 || phone.length > 15 || !message || message.length > 1800) return json(res, 400, { error: "Valid phone and message (1–1800 characters) are required" });
    if (await isOptedOut(business.id, phone)) return json(res, 409, { error: "This customer has opted out of WhatsApp messages" });
    const result = await sendText(connection.session_id, toChatId(phone), message);
    await supa("twiga_whatsapp_messages", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ business_id: business.id, session_id: connection.session_id, message_id: "manual_" + crypto.randomUUID(), chat_id: toChatId(phone), sender_id: "twiga_staff", direction: "outbound", body: message, status: "sent", metadata: { source: "dashboard", provider_message: result } }) });
    return json(res, 200, { sent: true });
  }
  if (req.method === "GET" && url.pathname === "/api/whatsapp/messages") {
    const { business } = await requireBusiness(req, businessId);
    const rows = await supa("twiga_whatsapp_messages?select=id,chat_id,sender_id,sender_name,direction,body,reply_body,status,created_at&business_id=eq." + encodeURIComponent(business.id) + "&order=created_at.desc&limit=50");
    return json(res, 200, { messages: rows || [] });
  }
  if (req.method === "POST" && url.pathname === "/api/whatsapp/followups") {
    const body = parseJson(await readBody(req)); const { user, business } = await requireBusiness(req, body.businessId);
    const phone = String(body.phone || "").replace(/\D/g, "");
    if (phone.length < 10 || phone.length > 15 || !body.message || !body.dueAt) return json(res, 400, { error: "Valid phone, message and dueAt are required" });
    if (body.consentConfirmed !== true) return json(res, 400, { error: "Confirm that the customer has opted in to WhatsApp follow-ups before scheduling" });
    const row = await supa("twiga_followups", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ business_id: business.id, customer_name: body.customerName || null, phone_number: phone, task: String(body.message).slice(0, 1500), channel: "whatsapp", due_at: body.dueAt, status: "scheduled", consent_status: "opted_in", created_by: user.id, metadata: { source: "twiga_whatsapp_reply", consent_confirmed_at: new Date().toISOString() } })
    });
    return json(res, 201, { followup: row?.[0] || null });
  }
  return json(res, 404, { error: "Not found" });
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") return json(res, 200, { ok: true });
    await route(req, res);
  } catch (error) {
    console.error("Request failed", error.message);
    json(res, error.status || 500, { error: error.status ? error.message : "Internal server error" });
  }
});
server.listen(PORT, "0.0.0.0", () => console.log("TWIGA WhatsApp Reply listening on", PORT));

async function processFollowups() {
  if (!SUPABASE_SERVICE_ROLE_KEY || !OPENWA_API_KEY) return;
  try {
    const due = await supa("twiga_followups?select=id,business_id,phone_number,task,metadata&channel=eq.whatsapp&status=eq.scheduled&consent_status=eq.opted_in&due_at=lte." + encodeURIComponent(new Date().toISOString()) + "&order=due_at.asc&limit=10");
    for (const item of due || []) {
      const claimed = await supa("twiga_followups?id=eq." + encodeURIComponent(item.id) + "&status=eq.scheduled", {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "in_progress", last_attempt_at: new Date().toISOString(), attempt_count: 1 })
      });
      if (!claimed?.length) continue;
      try {
        const connection = await getConnection(item.business_id);
        const phone = String(item.phone_number || "").replace(/\D/g, "");
        if (!connection || connection.status !== "connected" || await isOptedOut(item.business_id, phone)) throw new Error("WhatsApp is not connected or customer opted out");
        await sendText(connection.session_id, toChatId(phone), item.task);
        await supa("twiga_followups?id=eq." + encodeURIComponent(item.id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "completed", completed_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() }) });
      } catch (error) {
        await supa("twiga_followups?id=eq." + encodeURIComponent(item.id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", metadata: { ...(item.metadata || {}), last_error: error.message.slice(0, 300) } }) }).catch(() => {});
      }
    }
  } catch (error) { console.error("Follow-up worker error", error.message); }
}
setInterval(processFollowups, 30000).unref();
