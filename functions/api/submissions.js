import { json, preflight, geminiExtract, shape, n } from "./_lib.js";

export const onRequestOptions = () => preflight();

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const stmt = date
    ? env.DB.prepare("SELECT * FROM submissions WHERE sale_date=? ORDER BY created_at DESC").bind(date)
    : env.DB.prepare("SELECT * FROM submissions ORDER BY created_at DESC LIMIT 200");
  const { results } = await stmt.all();
  return json(results.map(shape));
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const { tenant, sale_date, image_base64, mime } = body || {};
  if (!tenant || !image_base64) return json({ error: "tenant と image_base64 は必須です" }, 400);

  const id = crypto.randomUUID();
  const contentType = mime || "image/jpeg";
  const bytes = Uint8Array.from(atob(image_base64), (ch) => ch.charCodeAt(0));
  await env.BUCKET.put(id, bytes, { httpMetadata: { contentType } });

  let g = {};
  try { g = await geminiExtract(env.GEMINI_API_KEY, env.GEMINI_MODEL || "gemini-2.5-flash", image_base64, contentType); }
  catch (e) { g = { _error: String(e.message || e).slice(0, 200) }; }

  const total = n(g.total_sales), ret = n(g.returns), disc = n(g.discounts), net = n(g.net_sales), cust = n(g.customers);
  const netRead = net != null ? net : (total != null ? total - (ret || 0) - (disc || 0) : null);
  const netFormula = total != null ? total - (ret || 0) - (disc || 0) : null;

  await env.DB.prepare(
    "INSERT INTO submissions (id,created_at,sale_date,tenant,image_key,vendor,raw_json,total_sales,returns,discounts,net_read,net_formula,customers,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')"
  ).bind(id, new Date().toISOString(), sale_date || new Date().toISOString().slice(0, 10), tenant, id, g.vendor || null, JSON.stringify(g), total, ret, disc, netRead, netFormula, cust).run();

  return json({ id });
}
