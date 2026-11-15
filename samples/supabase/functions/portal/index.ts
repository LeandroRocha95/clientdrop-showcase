// Public endpoint for the client portal. The only credential is the request token in the link.
import { admin, cors, json } from "../_shared/http.ts";
import { seal } from "../_shared/crypto.ts";

const MAX_TEXT = 20000;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_VIDEO = 2 * 1024 * 1024 * 1024; // item kind "video": uploaded straight to Storage (tus) into a reserved slot
const MAX_SLOTS_PENDING = 10;
const MAX_FILES_PER_ITEM = 20;
const MAX_WRITES_PER_MIN = 30; // per link, across every action that writes

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const token = String(body.token ?? "");
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return json({ error: "not_found" }, 404);

  const db = admin();
  const { data: r } = await db.from("requests")
    .select("id, workspace_id, client_id, title, message, status, due_at, first_opened_at, clients(name, contact_name, lang), workspaces(name, whatsapp, lang, logo_url)")
    .eq("token", token).maybeSingle();
  if (!r || r.status === "archived") return json({ error: "not_found" }, 404);

  const log = (kind: string, item_id: string | null = null, detail: string | null = null) =>
    db.from("events").insert({ workspace_id: r.workspace_id, request_id: r.id, item_id, kind, actor: "client", detail });

  const getItem = async (id: string) => {
    const { data } = await db.from("request_items").select("id, kind, status, files").eq("id", id).eq("request_id", r.id).maybeSingle();
    return data;
  };

  const markReceived = async (id: string, patch: Record<string, unknown>) => {
    await db.from("request_items").update({ ...patch, status: "received", received_at: new Date().toISOString(), reject_note: null }).eq("id", id);
    // close the request when every required item is in
    const { data: open } = await db.from("request_items").select("id").eq("request_id", r.id).eq("required", true).in("status", ["pending", "rejected"]);
    if (open && open.length === 0) {
      await db.from("requests").update({ status: "done" }).eq("id", r.id).eq("status", "open");
      await log("completed");
    }
  };

  // crude per-link throttle (the function is stateless): count this link's recent writes in the event log
  const WRITES = ["text", "secret", "upload_url", "upload_slot", "upload_done"];
  if (WRITES.includes(body.action)) {
    const since = new Date(Date.now() - 60000).toISOString();
    const { count } = await db.from("events").select("id", { count: "exact", head: true })
      .eq("request_id", r.id).eq("actor", "client").eq("kind", "received").gte("created_at", since);
    if ((count ?? 0) >= MAX_WRITES_PER_MIN) return json({ error: "rate_limited" }, 429);
  }

  switch (body.action) {
    case "load": {
      if (!r.first_opened_at) {
        await db.from("requests").update({ first_opened_at: new Date().toISOString() }).eq("id", r.id);
        await log("opened");
      }
      const { data: items } = await db.from("request_items")
        .select("id, kind, label, help, required, status, value_text, files, reject_note, position")
        .eq("request_id", r.id).order("position");
      return json({
        request: { title: r.title, message: r.message, due_at: r.due_at, status: r.status },
        client: r.clients, agency: { name: (r.workspaces as any)?.name, whatsapp: (r.workspaces as any)?.whatsapp, logo_url: (r.workspaces as any)?.logo_url ?? null },
        // never send back secrets; file paths are reduced to names
        items: (items ?? []).map((i: any) => ({
          id: i.id, kind: i.kind, label: i.label, help: i.help, required: i.required, status: i.status, reject_note: i.reject_note,
          value_text: i.kind === "text" ? i.value_text : null,
          files: (i.files ?? []).map((f: any) => ({ name: f.name, size: f.size })),
        })),
      });
    }
    case "text":
    case "secret": {
      const item = await getItem(String(body.item_id));
      const value = String(body.value ?? "").trim();
      if (!item || value.length === 0 || value.length > MAX_TEXT) return json({ error: "invalid" }, 400);
      if (body.action === "text" && item.kind !== "text") return json({ error: "invalid" }, 400);
      if (body.action === "secret" && !["secret", "access"].includes(item.kind)) return json({ error: "invalid" }, 400);
      if (item.status === "approved") return json({ error: "locked" }, 409);
      if (body.action === "text") await markReceived(item.id, { value_text: value });
      else await markReceived(item.id, { secret_cipher: await seal(value, item.id) });
      await log("received", item.id);
      return json({ ok: true });
    }
    case "upload_url": {
      const item = await getItem(String(body.item_id));
      const size = Number(body.size ?? 0);
      if (!item || item.kind !== "file" || !(size > 0) || size > MAX_FILE) return json({ error: "invalid" }, 400);
      if (item.status === "approved") return json({ error: "locked" }, 409);
      if ((item.files ?? []).length >= MAX_FILES_PER_ITEM) return json({ error: "too_many_files" }, 400);
      const name = String(body.name ?? "file").normalize("NFKD").replace(/[^\w.\- ]+/g, "").slice(-120) || "file";
      const path = `${r.workspace_id}/${r.id}/${item.id}/${crypto.randomUUID().slice(0, 8)}-${name}`;
      const { data, error } = await db.storage.from("clientdrop").createSignedUploadUrl(path);
      if (error) return json({ error: "storage" }, 500);
      return json({ path, token: data.token, signedUrl: data.signedUrl });
    }
    case "upload_slot": {
      const item = await getItem(String(body.item_id));
      const size = Number(body.size ?? 0);
      if (!item || item.kind !== "video" || !(size > 0) || size > MAX_VIDEO) return json({ error: "invalid" }, 400);
      if (item.status === "approved") return json({ error: "locked" }, 409);
      if ((item.files ?? []).length >= MAX_FILES_PER_ITEM) return json({ error: "too_many_files" }, 400);
      const { count: pending } = await db.from("request_upload_slots").select("path", { count: "exact", head: true })
        .eq("item_id", item.id).eq("status", "pending").gte("created_at", new Date(Date.now() - 3 * 86400000).toISOString());
      if ((pending ?? 0) >= MAX_SLOTS_PENDING) return json({ error: "too_many_files" }, 429);
      const name = String(body.name ?? "video").normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\.{2,}/g, ".").slice(-120) || "video";
      const path = `${r.workspace_id}/${r.id}/${item.id}/${crypto.randomUUID().slice(0, 8)}-${name}`;
      const { error } = await db.from("request_upload_slots").insert({ path, item_id: item.id, request_id: r.id, workspace_id: r.workspace_id });
      if (error) return json({ error: "storage" }, 500);
      return json({ path });
    }
    case "upload_done": {
      const item = await getItem(String(body.item_id));
      const path = String(body.path ?? "");
      if (!item || !["file", "video"].includes(item.kind) || !path.startsWith(`${r.workspace_id}/${r.id}/${item.id}/`) || path.includes("..")) return json({ error: "invalid" }, 400);
      // an approved item is final: a stale upload URL must not reopen it
      if (item.status === "approved") return json({ error: "locked" }, 409);
      if ((item.files ?? []).length >= MAX_FILES_PER_ITEM || (item.files ?? []).some((f: any) => f.path === path)) return json({ error: "invalid" }, 400);
      const dir = path.slice(0, path.lastIndexOf("/"));
      const file = path.slice(path.lastIndexOf("/") + 1);
      const { data: found } = await db.storage.from("clientdrop").list(dir, { search: file });
      const obj = (found ?? []).find((o: any) => o.name === file);
      if (!obj) return json({ error: "missing" }, 400);
      if (Number((obj as any).metadata?.size ?? 0) > (item.kind === "video" ? MAX_VIDEO : MAX_FILE)) return json({ error: "invalid" }, 400);
      if (item.kind === "video") {
        const { data: slot } = await db.from("request_upload_slots").select("path").eq("path", path).eq("item_id", item.id).eq("status", "pending").maybeSingle();
        if (!slot) return json({ error: "invalid" }, 400);
        await db.from("request_upload_slots").update({ status: "done" }).eq("path", path);
      }
      const files = [...(item.files ?? []), { path, name: file.slice(9), size: (obj as any).metadata?.size ?? 0, at: new Date().toISOString() }];
      await markReceived(item.id, { files });
      await log("received", item.id, file.slice(9));
      return json({ ok: true });
    }
    default:
      return json({ error: "action" }, 400);
  }
});
