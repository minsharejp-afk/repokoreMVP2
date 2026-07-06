import { json, preflight, geminiExtract, shape, n, deriveNet } from "./_lib.js";

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

  const cust = n(g.customers);
  const net = n(g.net_sales);
  const { computed, hasBreakdown } = deriveNet(g);       // 構成要素の符号付き合計（コード側で検算）
  const netRead = net != null ? net : computed;          // 印字の純売上（無ければ計算値）
  const netFormula = computed;

  // OCR結果（将来接続用の空きスロット）。今は送られてこないので null のまま＝現行動作。
  const ocr = (body && body.ocr) || {};
  const ocrNet = n(ocr.net_sales != null ? ocr.net_sales : ocr.net);
  const ocrCust = n(ocr.customers);
  const ocrRaw = (ocr && Object.keys(ocr).length) ? JSON.stringify(ocr) : null;
  const ocrConnected = (ocrNet != null || ocrCust != null);

  // 自動承認の条件。現行は「縦計成立＋客数あり」。将来 REQUIRE_OCR_MATCH=1 で「両者一致 かつ 縦計成立」へ切替。
  const requireOcr = (env.REQUIRE_OCR_MATCH === "1" || env.REQUIRE_OCR_MATCH === "true");
  const tatekeiOk = hasBreakdown && computed != null && netRead != null && computed === netRead && cust != null;
  const ocrAgrees = ocrConnected && ocrNet != null && ocrNet === netRead && ocrCust != null && ocrCust === cust;
  const clean = requireOcr ? (tatekeiOk && ocrAgrees) : tatekeiOk; // OCR未接続時は現行動作を維持
  const now = new Date().toISOString();
  const status = clean ? "approved" : "pending";
  const netFinal = clean ? netRead : null;
  const custFinal = clean ? cust : null;
  const approvedBy = clean ? "auto" : null;
  const approvedAt = clean ? now : null;

  const total = n(g.total_sales), ret = n(g.returns), disc = n(g.discounts); // 参照用（旧列・任意）

  await env.DB.prepare(
    "INSERT INTO submissions (id,created_at,sale_date,tenant,image_key,vendor,raw_json,total_sales,returns,discounts,net_read,net_formula,customers,ocr_net,ocr_customers,ocr_raw,status,net_final,cust_final,approved_by,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(id, now, sale_date || now.slice(0, 10), tenant, id, g.vendor || null, JSON.stringify(g), total, ret, disc, netRead, netFormula, cust, ocrNet, ocrCust, ocrRaw, status, netFinal, custFinal, approvedBy, approvedAt).run();

  if (clean) {
    await env.DB.prepare("INSERT INTO audit (submission_id,ts,actor,action,detail) VALUES (?,?,?,?,?)")
      .bind(id, now, "auto", "auto-approve", JSON.stringify({ netFinal, custFinal, reason: requireOcr ? "OCR一致＋縦計成立＋客数あり" : "構成要素の合計が純売上と一致＋客数あり" })).run();
  }

  return json({ id, auto_approved: clean });
}
