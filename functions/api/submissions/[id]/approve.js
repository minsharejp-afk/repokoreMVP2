import { json, preflight } from "../../_lib.js";

export const onRequestOptions = () => preflight();

export async function onRequestPost(context) {
  const { env, params, request } = context;
  let b; try { b = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const netFinal = b.net_final == null ? null : Math.round(Number(b.net_final));
  const custFinal = b.cust_final == null ? null : Math.round(Number(b.cust_final));
  const actor = b.actor || "admin";
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE submissions SET status='approved', net_final=?, cust_final=?, approved_by=?, approved_at=? WHERE id=?")
    .bind(netFinal, custFinal, actor, now, params.id).run();
  await env.DB.prepare("INSERT INTO audit (submission_id,ts,actor,action,detail) VALUES (?,?,?,?,?)")
    .bind(params.id, now, actor, "approve", JSON.stringify({ netFinal, custFinal })).run();
  return json({ ok: true });
}
