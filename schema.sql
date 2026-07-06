-- D1 スキーマ： wrangler d1 execute repokore --file=schema.sql で適用
CREATE TABLE IF NOT EXISTS submissions (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  sale_date    TEXT NOT NULL,
  tenant       TEXT NOT NULL,
  image_key    TEXT,
  vendor       TEXT,
  raw_json     TEXT,            -- Gemini の生抽出結果(JSON)
  total_sales  INTEGER,
  returns      INTEGER,
  discounts    INTEGER,
  net_read     INTEGER,         -- 純売上（レシート読取値）
  net_formula  INTEGER,         -- 総売上−返品−割引（アプリ側で確定計算）
  customers    INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | approved
  net_final    INTEGER,
  cust_final   INTEGER,
  approved_by  TEXT,
  approved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sub_date ON submissions (sale_date);
CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions (status);

CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT,
  ts            TEXT,
  actor         TEXT,
  action        TEXT,
  detail        TEXT
);
