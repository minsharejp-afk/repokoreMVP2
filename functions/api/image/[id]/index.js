export async function onRequestGet(context) {
  const obj = await context.env.BUCKET.get(context.params.id);
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("Cache-Control", "private, max-age=3600");
  return new Response(obj.body, { headers: h });
}
