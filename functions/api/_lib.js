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

export const fmt = (v) => (v == null ? "—" : Number(v).toLocaleString("ja-JP"));

// 「読取が確実か」の判定（自動承認に使用・shapeと共通の基準）
export function isClean(total, ret, disc, netRead, netFormula, cust) {
  const holds = netFormula != null && netRead != null && netFormula === netRead;
  return holds && cust != null; // 縦計が合致し、客数も読めている
}

// D1行 → 画面用オブジェクト（重大度・信頼度・縦計・思考プロセスをここで導出）
export function shape(r) {
  let raw = {}; try { raw = JSON.parse(r.raw_json || "{}"); } catch {}
  const hasBreakdown = r.total_sales != null;
  const holds = hasBreakdown && r.net_formula != null && r.net_read != null && r.net_formula === r.net_read;
  const mismatch = hasBreakdown && r.net_formula != null && r.net_read != null && r.net_formula !== r.net_read;
  const approved = r.status === "approved";
  const auto = r.approved_by === "auto";

  // 信頼度（0-100）: 透明性重視の単純ルール
  let netConf;
  if (!hasBreakdown) netConf = r.net_read == null ? 10 : 70;   // 内訳なし＝縦計で確かめられない
  else if (holds) netConf = 96;                                 // 縦計一致＝内部整合
  else if (mismatch) netConf = 35;                              // 縦計不一致＝誤読の疑い
  else netConf = r.net_read == null ? 10 : 60;
  const custConf = r.customers == null ? 40 : 90;
  const overall = Math.min(netConf, custConf);

  const netSev = approved ? "green" : (netConf >= 90 ? "green" : netConf >= 60 ? "amber" : "red");
  const custSev = approved ? "green" : (custConf >= 85 ? "green" : "amber");

  // 縦計（総売上 − 返品 − 割引 = 計算値。純売上(読取)と照合）
  const tatekei = {
    hasBreakdown,
    rows: hasBreakdown ? [
      { label: "総売上", op: "", value: r.total_sales },
      { label: "返品", op: "−", value: r.returns || 0 },
      { label: "割引", op: "−", value: r.discounts || 0 },
    ] : [],
    computed: r.net_formula,
    read: r.net_read,
    holds, mismatch,
    diff: (r.net_formula != null && r.net_read != null) ? (r.net_read - r.net_formula) : null,
  };

  // 思考プロセス（人が読める説明）
  const reasons = [];
  if (hasBreakdown) {
    reasons.push(`総売上 ${fmt(r.total_sales)} から 返品 ${fmt(r.returns || 0)}・割引 ${fmt(r.discounts || 0)} を引くと ${fmt(r.net_formula)}（縦計の計算値）。`);
    if (holds) reasons.push(`レシートの純売上(読取) ${fmt(r.net_read)} と一致 → 内部の算術が整合。純売上の信頼度 ${netConf}%。`);
    else if (mismatch) reasons.push(`純売上(読取) ${fmt(r.net_read)} と ${fmt(Math.abs(tatekei.diff))} ズレ（不一致）→ どちらかが誤読の疑い。信頼度 ${netConf}%。`);
    else reasons.push(`純売上が読み取れないため照合できません。信頼度 ${netConf}%。`);
  } else {
    reasons.push(`内訳（総売上・返品・割引）が読めず縦計で照合できません。読取値のみ。信頼度 ${netConf}%。`);
  }
  reasons.push(r.customers == null ? `客数が読み取れませんでした（要確認）。` : `客数 ${fmt(r.customers)} を読取（信頼度 ${custConf}%）。`);
  reasons.push(approved
    ? (auto ? `いずれも確実（縦計一致＋主要項目あり）のため自動承認しました。` : `担当者が確認して承認しました。`)
    : (netSev === "red" || custSev === "red") ? `不一致があるため要修正（人の確認が必要）。` : `不確かな項目があるため要確認（人の確認が必要）。`);

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
    approved, auto,
    status: approved ? (auto ? "自動承認" : "承認済み") : (netSev === "red" || custSev === "red") ? "要修正" : "要確認",
    netSev, custSev, netConf, custConf, overall,
    total_sales: r.total_sales, returns: r.returns, discounts: r.discounts,
    net_read: r.net_read, net_formula: r.net_formula, customers: r.customers,
    hasBreakdown, holds, mismatch, formula, candidates, tatekei, reasons,
    net_final: r.net_final, cust_final: r.cust_final,
    vendor: r.vendor, lines: Array.isArray(raw.lines) ? raw.lines : [],
    error: raw._error || null,
    imageUrl: "/api/image/" + r.id,
  };
}
