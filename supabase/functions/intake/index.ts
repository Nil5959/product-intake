// Product intake API. verify_jwt is off: auth is the secret key `k` from the page URL hash.
// The DB (RLS on, no policies) and the private bucket are reached only here, with the service role.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ORIGINS = ["https://nil5959.github.io"];
const MAX_PRODUCTS = 500, MAX_IMAGES = 30, MAX_BYTES = 8 * 1024 * 1024, URL_TTL = 7 * 24 * 3600;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function clean(v: unknown, max: number) {
  return String(v ?? "").replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, max);
}
async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin" };
  if (ORIGINS.includes(origin)) cors["Access-Control-Allow-Origin"] = origin;
  const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
  const fail = (error: string, status = 400) => out({ ok: false, error }, status);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Max-Age": "86400" } });
  if (req.method !== "POST") return fail("method", 405);

  // Body: text/plain JSON for actions, multipart for uploads (both "simple" requests: no preflight, keepalive works).
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES + 64 * 1024) return fail("toolarge", 413);
  let p: Record<string, unknown> = {}, file: File | null = null;
  try {
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const fd = await req.formData();
      for (const [k, v] of fd) { if (typeof v === "string") p[k] = v; else if (k === "file") file = v; }
    } else p = JSON.parse(await req.text());
    if (!p || typeof p !== "object") throw 0;
  } catch { return fail("body"); }

  if (p.action === "ping") { // keep-alive from the GitHub cron, so the free project never pauses
    const { error } = await db.from("clients").select("id", { head: true, count: "exact" });
    return error ? fail("db", 500) : out({ ok: true });
  }
  const k = String(p.k ?? "");
  if (k.length < 32 || k.length > 128) return fail("auth", 401);
  const { data: cl, error: clErr } = await db.from("clients").select("id,display").eq("token_hash", await sha256(k)).maybeSingle();
  if (clErr) return fail("db", 500);
  if (!cl) return fail("auth", 401);
  const client = cl.id as string;

  const id = String(p.id ?? "");
  if (id && !UUID.test(id)) return fail("id");
  async function own() { // product belongs to this client?
    const { data } = await db.from("products").select("id").eq("id", id).eq("client", client).maybeSingle();
    return !!data;
  }
  async function list() {
    const { data: prods, error } = await db.from("products").select("id,cat_id,model_id,category,model,name,link,price,notes,is_main,created_at,images(id,path,orig,created_at)")
      .eq("client", client).order("created_at").order("created_at", { referencedTable: "images" });
    if (error) return fail("db", 500);
    const paths = prods.flatMap((x) => x.images.map((i) => i.path));
    const urls: Record<string, string> = {};
    if (paths.length) {
      const { data: s } = await db.storage.from("intake").createSignedUrls(paths, URL_TTL);
      for (const u of s ?? []) if (u.path && u.signedUrl) urls[u.path] = u.signedUrl;
    }
    return out({ ok: true, who: cl!.display, products: prods.map((x) => ({
      id: x.id, cat: x.cat_id, mod: x.model_id, category: x.category, model: x.model, name: x.name, link: x.link, notes: x.notes, main: x.is_main,
      price: x.price === null ? null : Number(x.price),
      images: x.images.map((i) => ({ f: i.id, orig: i.orig, url: urls[i.path] ?? "" })),
    })) });
  }

  switch (p.action) {
    case "list": return list();

    case "add": {
      const { count } = await db.from("products").select("id", { count: "exact", head: true }).eq("client", client);
      if ((count ?? 0) >= MAX_PRODUCTS) return fail("full");
      // Groups are fixed ids, not names: "+ model in this type" passes cat, "+ variation" passes cat and mod.
      const row: Record<string, unknown> = { client, category: clean(p.category, 120), model: clean(p.model, 120) };
      if (UUID.test(String(p.cat ?? ""))) row.cat_id = p.cat;
      if (UUID.test(String(p.mod ?? ""))) row.model_id = p.mod;
      const { error } = await db.from("products").insert(row);
      return error ? fail("db", 500) : list();
    }

    case "update": {
      const f = String(p.field ?? ""), v = String(p.value ?? "");
      const t = Math.floor(Number(p.t)); // client time of the edit: an older save arriving late never overwrites a newer one
      if (!Number.isSafeInteger(t) || t <= 0) return fail("t");
      let patch: Record<string, unknown>;
      if (f === "name") patch = { name: clean(v, 200) };
      else if (f === "category" || f === "model") patch = { [f]: clean(v, 120) };
      else if (f === "notes") patch = { notes: String(v).replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "").trim().slice(0, 2000) }; // keeps line breaks
      else if (f === "link") {
        const l = clean(v, 1000);
        if (l && !/^https?:\/\/[^\s]+$/i.test(l)) return fail("link");
        patch = { link: l };
      } else if (f === "price") {
        const n = Number(v);
        if (v.trim() !== "" && !isFinite(n)) return fail("price");
        patch = { price: v.trim() === "" ? null : Math.max(0, Math.min(10000000, Math.round(n * 100) / 100)) };
      } else return fail("field");
      const { data, error } = await db.from("products").update({ ...patch, [f + "_t"]: t, updated_at: new Date().toISOString() })
        .eq("id", id).eq("client", client).lt(f + "_t", t).select("id");
      if (error) return fail("db", 500);
      if (!data?.length) { // nothing written: row gone, a duplicate, or a newer edit is already there
        const { data: cur } = await db.from("products").select(f + "_t").eq("id", id).eq("client", client).maybeSingle();
        if (!cur) return fail("notfound", 404);
        const st = Number((cur as Record<string, unknown>)[f + "_t"]);
        if (st !== t) return out({ ok: false, error: "stale", t: st }, 409); // the page resends with a later time
      }
      return out({ ok: true }); // no list here: keeps keepalive saves cheap
    }

    case "delete": {
      if (!(await own())) return list();
      const { data: imgs, error: e1 } = await db.from("images").select("path").eq("product_id", id);
      if (e1) return fail("db", 500);
      const { error: e2 } = await db.from("products").delete().eq("id", id).eq("client", client); // images rows cascade
      if (e2) return fail("db", 500);
      if (imgs?.length) await db.storage.from("intake").remove(imgs.map((i) => i.path));
      return list();
    }

    case "main": { // mark the main variation of a model: `ids` = all variations of that model as shown on the page
      const ids = String(p.ids ?? "").split(",").filter((x) => UUID.test(x)).slice(0, MAX_PRODUCTS);
      if (!ids.includes(id)) return fail("id");
      const { error: e1 } = await db.from("products").update({ is_main: false }).eq("client", client).in("id", ids);
      const { error: e2 } = await db.from("products").update({ is_main: true }).eq("client", client).eq("id", id);
      return e1 || e2 ? fail("db", 500) : list();
    }

    case "rmimg": {
      if (!(await own())) return fail("notfound", 404);
      const f = String(p.f ?? "");
      if (!UUID.test(f)) return fail("id");
      const { data: im } = await db.from("images").select("path").eq("id", f).eq("product_id", id).maybeSingle();
      if (im) {
        const { error } = await db.from("images").delete().eq("id", f);
        if (error) return fail("db", 500);
        await db.storage.from("intake").remove([im.path]);
      }
      return list();
    }

    case "upload": {
      if (!(await own())) return fail("notfound", 404);
      if (!file) return fail("upload");
      if (file.size > MAX_BYTES) return fail("toolarge");
      const { count } = await db.from("images").select("id", { count: "exact", head: true }).eq("product_id", id);
      if ((count ?? 0) >= MAX_IMAGES) return fail("toomany");
      const buf = new Uint8Array(await file.arrayBuffer());
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return fail("notimage"); // JPEG only (page converts)
      const path = `${client}/${id}/${crypto.randomUUID()}.jpg`;
      const up = await db.storage.from("intake").upload(path, buf, { contentType: "image/jpeg" });
      if (up.error) return fail("storage", 500);
      const { error } = await db.from("images").insert({ product_id: id, path, orig: clean(file.name, 120) });
      if (error) { await db.storage.from("intake").remove([path]); return fail("db", 500); }
      return list();
    }

    default: return fail("action");
  }
});
