// 共有ユーティリティ（先頭が "_" のファイルはルートにならない）
const CORS = {
  "Access-Control-Allow-Origin": "*", // 本番: テナントアプリのオリジンに限定すること
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });
}
export function preflight() { return new Response(null, { status: 204, headers: CORS }); }

export const n = (v) => (v == null || v === "" || isNaN(Number(v))) ? null : Math.round(Number(v));

// Gemini でレシート画像から構造化データを抽出（サーバ側・シークレットキー使用）
export async function geminiExtract(key, model, base64, mime) {
  if (!key) throw new Error("GEMINI_API_KEY 未設定");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const prompt = '次のJSONのみを返してください（前後の説明やコードブロックは不要）:\n{"store":"店名(推定)","vendor":"POSベンダー名(推定)","total_sales":整数かnull,"returns":整数かnull,"discounts":整数かnull,"net_sales":整数かnull,"customers":整数かnull,"lines":[{"label":"項目名","value":"値"}]}\nこれは日本の店舗の精算レシート画像です。総売上・返品・割引・純売上・客数を読み取り、その他の明細はlinesに入れてください。金額はカンマや¥を除いた整数。読み取れない値はnull。';
  const body = { contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0 } };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("Gemini API " + res.status + ": " + (await res.text()).slice(0, 160));
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// D1行 → 画面用オブジェクト（重大度・候補・式はここで導出）
export function shape(r) {
  let raw = {}; try { raw = JSON.parse(r.raw_json || "{}"); } catch {}
  const hasBreakdown = r.total_sales != null;
  const mismatch = hasBreakdown && r.net_formula != null && r.net_read != null && r.net_formula !== r.net_read;
  const approved = r.status === "approved";
  const netSev = approved ? "green" : mismatch ? "red" : (r.net_read == null ? "amber" : "green");
  const custSev = approved ? "green" : (r.customers == null ? "amber" : "green");
  let candidates;
  if (hasBreakdown) {
    candidates = mismatch
      ? [{ v: r.net_read, note: "レシート読取値", star: false }, { v: r.net_formula, note: "式成立（総売上−返品−割引）", star: true }]
      : [{ v: (r.net_read != null ? r.net_read : r.net_formula), note: "式成立・読取一致", star: true }];
  } else {
    candidates = [{ v: r.net_read, note: "レシート読取値", star: true }];
  }
  const formula = "純売上 ＝ 総売上" + (r.returns ? " − 返品" : "") + (r.discounts ? " − 割引" : "");
  return {
    id: r.id, tenant: r.tenant, sale_date: r.sale_date, created_at: r.created_at,
    status: approved ? "承認済み" : (netSev === "red" || custSev === "red") ? "未着手" : "未着手",
    approved, netSev, custSev,
    total_sales: r.total_sales, returns: r.returns, discounts: r.discounts,
    net_read: r.net_read, net_formula: r.net_formula, customers: r.customers,
    hasBreakdown, formula, candidates,
    net_final: r.net_final, cust_final: r.cust_final,
    vendor: r.vendor, lines: Array.isArray(raw.lines) ? raw.lines : [],
    error: raw._error || null,
    imageUrl: "/api/image/" + r.id,
  };
}
