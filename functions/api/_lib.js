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
  const prompt = '次のJSONのみを返してください（前後の説明やコードブロックは不要）:\n'
    + '{"store":"店名(推定)","vendor":"POSベンダー名(推定)","net_sales":整数かnull,"customers":整数かnull,'
    + '"components":[{"label":"項目名","value":正の整数,"sign":"+"または"-"}],'
    + '"lines":[{"label":"項目名","value":"値"}]}\n'
    + 'これは日本の店舗の精算レシート画像です。\n'
    + '・net_sales: レシートに「純売上」等として印字されている最終的な純売上の額。\n'
    + '・components: その純売上を構成する項目を、レシートの表記・意味どおりに符号付きで列挙する。総売上や各種売上高は "+"、返品・返金・値引・割引・各種控除は "-"。value は金額の大きさ（正の整数）。\n'
    + '  重要: 合計が純売上に一致するように項目や符号を選んではいけない。あくまで各項目の意味で符号を決めること（後段で機械的に検算する）。純売上そのものや小計・合計行は components に入れない。\n'
    + '・customers: 客数。\n'
    + '・lines: 読み取れた明細行すべて（確認用）。\n'
    + '金額はカンマや¥を除いた整数。読み取れない値はnull。';
  const body = { contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0 } };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("Gemini API " + res.status + ": " + (await res.text()).slice(0, 160));
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

export const fmt = (v) => (v == null ? "—" : Number(v).toLocaleString("ja-JP"));

// 純売上の構成要素をGeminiの抽出結果から取り出し、コード側で符号付き合計を検算する。
// 符号は「項目の意味」でGeminiが付与。合計に合わせて項目を選ぶ（部分和フィッティング）はしない。
export function deriveNet(g) {
  const toInt = (x) => (x == null || x === "" || isNaN(Number(x))) ? null : Math.round(Number(x));
  let comps = [];
  if (Array.isArray(g.components) && g.components.length) {
    comps = g.components.map((x) => {
      const iv = toInt(x.value);
      const sign = (String(x.sign).trim() === "-" || Number(x.value) < 0) ? -1 : 1;
      return { label: String(x.label || ""), value: iv == null ? null : Math.abs(iv), sign };
    }).filter((x) => x.value != null);
  } else {
    // 後方互換: 旧フィールド（総売上・返品・割引）
    const t = toInt(g.total_sales), r = toInt(g.returns), d = toInt(g.discounts);
    if (t != null) {
      comps = [{ label: "総売上", value: Math.abs(t), sign: 1 }];
      if (r) comps.push({ label: "返品", value: Math.abs(r), sign: -1 });
      if (d) comps.push({ label: "割引", value: Math.abs(d), sign: -1 });
    }
  }
  const hasBreakdown = comps.length > 0;
  const computed = hasBreakdown ? comps.reduce((s, x) => s + x.sign * x.value, 0) : null;
  return { components: comps, computed, hasBreakdown };
}

// OCR × Gemini の突合・仲裁。OCR値が無ければ「未接続」で現行動作（Gemini＋縦計）にフォールバック。
// 不一致のときは縦計（式）が成立する方を仮正とし、決着しなければGeminiを仮採用する。
function reconcileField(gem, ocr, formulaVal) {
  if (ocr == null) return { status: "ocr_absent", provisional: gem, source: "gemini", agree: null };
  if (gem != null && gem === ocr) return { status: "agree", provisional: gem, source: "both", agree: true };
  if (formulaVal != null) {
    if (ocr === formulaVal && gem !== formulaVal) return { status: "arbitrated_ocr", provisional: ocr, source: "ocr(式成立)", agree: false };
    if (gem === formulaVal && ocr !== formulaVal) return { status: "arbitrated_gemini", provisional: gem, source: "gemini(式成立)", agree: false };
  }
  return { status: "undecided", provisional: (gem != null ? gem : ocr), source: "gemini(仮)", agree: false };
}
export function reconcile({ geminiNet, ocrNet, computed, geminiCust, ocrCust }) {
  return {
    connected: (ocrNet != null || ocrCust != null),
    net: reconcileField(geminiNet, ocrNet, computed),
    cust: reconcileField(geminiCust, ocrCust, null),
  };
}

// D1行 → 画面用オブジェクト（重大度・信頼度・縦計・思考プロセスをここで導出）
export function shape(r) {
  let raw = {}; try { raw = JSON.parse(r.raw_json || "{}"); } catch {}
  const { components, computed, hasBreakdown } = deriveNet(raw);
  const netRead = r.net_read;
  const holds = computed != null && netRead != null && computed === netRead;
  const mismatch = computed != null && netRead != null && computed !== netRead;
  const approved = r.status === "approved";
  const auto = r.approved_by === "auto";

  // 信頼度（0-100）: 透明性重視の単純ルール
  let netConf;
  if (!hasBreakdown) netConf = netRead == null ? 10 : 70;   // 構成要素が取れず検算できない
  else if (holds) netConf = 96;                             // 構成要素の合計が純売上と一致
  else if (mismatch) netConf = 35;                          // 不一致＝誤読／項目漏れの疑い
  else netConf = netRead == null ? 10 : 60;
  const custConf = r.customers == null ? 40 : 90;
  const overall = Math.min(netConf, custConf);

  const netSev = approved ? "green" : (netConf >= 90 ? "green" : netConf >= 60 ? "amber" : "red");
  const custSev = approved ? "green" : (custConf >= 85 ? "green" : "amber");

  // 縦計（レシートごとの構成要素を符号付きで積み上げ、純売上(読取)と照合）
  const tatekei = {
    hasBreakdown,
    rows: components.map((x, i) => ({ label: x.label, op: i === 0 ? "" : (x.sign < 0 ? "−" : "+"), value: x.value })),
    computed,
    read: netRead,
    holds, mismatch,
    diff: (computed != null && netRead != null) ? (netRead - computed) : null,
  };
  const expr = components.map((x, i) => (i === 0 ? "" : (x.sign < 0 ? " − " : " + ")) + x.label).join("");

  // OCR × Gemini の突合（OCR未接続なら現行動作にフォールバック）
  const ocr = reconcile({ geminiNet: netRead, ocrNet: r.ocr_net, computed, geminiCust: r.customers, ocrCust: r.ocr_customers });
  const ocrLabel = (f) => ({
    ocr_absent: "OCR未接続", agree: "OCRと一致", arbitrated_ocr: "不一致→縦計でOCR採用",
    arbitrated_gemini: "不一致→縦計でGemini採用", undecided: "不一致→決着せず(Gemini仮)",
  }[f.status] || "—");

  // 思考プロセス（人が読める説明）
  const reasons = [];
  if (hasBreakdown) {
    reasons.push(`このレシートの純売上の構成: ${expr}。`);
    reasons.push(`各項目を符号どおり合計すると ${fmt(computed)}（縦計の計算値）。`);
    if (holds) reasons.push(`印字の純売上 ${fmt(netRead)} と一致 → 構成要素と整合。純売上の信頼度 ${netConf}%。`);
    else if (mismatch) reasons.push(`印字の純売上 ${fmt(netRead)} と ${fmt(Math.abs(tatekei.diff))} ズレ（不一致）→ いずれかの誤読か項目の取りこぼしの疑い。信頼度 ${netConf}%。`);
    else reasons.push(`純売上が読み取れないため照合できません。信頼度 ${netConf}%。`);
  } else {
    reasons.push(`純売上の構成要素が読み取れず、検算できません。読取値のみ。信頼度 ${netConf}%。`);
  }
  reasons.push(r.customers == null ? `客数が読み取れませんでした（要確認）。` : `客数 ${fmt(r.customers)} を読取（信頼度 ${custConf}%）。`);
  reasons.push(ocr.connected
    ? `OCR突合: 純売上=${ocrLabel(ocr.net)}／客数=${ocrLabel(ocr.cust)}。`
    : `OCR突合: 未接続（現在はGemini＋縦計で判断）。OCRが繋がると二重チェックが有効化。`);
  reasons.push(approved
    ? (auto ? `構成要素の合計が純売上と一致し客数も読めたため自動承認しました。` : `担当者が確認して承認しました。`)
    : (netSev === "red" || custSev === "red") ? `不一致があるため要修正（人の確認が必要）。` : `不確かな項目があるため要確認（人の確認が必要）。`);

  let candidates;
  if (hasBreakdown) {
    candidates = mismatch
      ? [{ v: netRead, note: "レシート読取値", star: false }, { v: computed, note: "構成要素の合計", star: true }]
      : [{ v: (netRead != null ? netRead : computed), note: "構成一致・読取一致", star: true }];
  } else {
    candidates = [{ v: netRead, note: "レシート読取値", star: true }];
  }
  const formula = hasBreakdown ? ("純売上 ＝ " + expr) : "純売上（構成要素なし）";

  return {
    id: r.id, tenant: r.tenant, sale_date: r.sale_date, created_at: r.created_at,
    approved, auto,
    status: approved ? (auto ? "自動承認" : "承認済み") : (netSev === "red" || custSev === "red") ? "要修正" : "要確認",
    netSev, custSev, netConf, custConf, overall,
    total_sales: r.total_sales, returns: r.returns, discounts: r.discounts,
    net_read: r.net_read, net_formula: computed, customers: r.customers,
    hasBreakdown, holds, mismatch, formula, candidates, tatekei, reasons,
    ocr: { connected: ocr.connected, net: ocr.net.status, cust: ocr.cust.status, netLabel: ocrLabel(ocr.net), custLabel: ocrLabel(ocr.cust) },
    net_final: r.net_final, cust_final: r.cust_final,
    vendor: r.vendor, lines: Array.isArray(raw.lines) ? raw.lines : [],
    error: raw._error || null,
    imageUrl: "/api/image/" + r.id,
  };
}
