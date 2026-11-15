// AES-256-GCM, server-side only. Ciphertext format: <version>:<iv>:<ciphertext>, AAD = item id.
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function unb64(s: string) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

const keys: Record<string, Promise<CryptoKey>> = {};
// v2 = dedicated key CD_SECRET_KEY (32 bytes base64), independent from Supabase keys: rotating the
//      service role key does not touch it. Used for every new secret as soon as it is configured.
// v1 = legacy key derived (HKDF) from the service role key. Kept only to decrypt data sealed before v2.
function key(v: string) {
  if (!keys[v]) {
    if (v === "v2") {
      const raw = Deno.env.get("CD_SECRET_KEY");
      if (!raw) throw new Error("CD_SECRET_KEY not set");
      const bytes = unb64(raw);
      if (bytes.length !== 32) throw new Error("CD_SECRET_KEY must be 32 bytes");
      keys[v] = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    } else {
      keys[v] = (async () => {
        const base = await crypto.subtle.importKey("raw", enc.encode(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!), "HKDF", false, ["deriveKey"]);
        return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("clientdrop-v1"), info: enc.encode("secrets") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      })();
    }
  }
  return keys[v];
}

export async function seal(plain: string, aad: string): Promise<string> {
  const v = Deno.env.get("CD_SECRET_KEY") ? "v2" : "v1";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await key(v), enc.encode(plain)));
  return v + ":" + b64(iv) + ":" + b64(ct);
}

export async function open(sealed: string, aad: string): Promise<string> {
  const [v, iv, ct] = sealed.split(":");
  if (v !== "v1" && v !== "v2") throw new Error("bad cipher");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(aad) }, await key(v), unb64(ct));
  return dec.decode(pt);
}
