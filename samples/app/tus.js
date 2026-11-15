/* Minimal resumable upload (tus 1.0.0) for Supabase Storage.
   Big videos from a phone: 6 MB chunks, progress, automatic retry, resume after the page was closed
   (the tus URL is kept in localStorage under opts.resumeKey). No dependencies. */
(() => {
  const CHUNK = 6 * 1024 * 1024; // Supabase Storage requires exactly 6 MB chunks
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const sleep = (ms, signal) => new Promise((res, rej) => {
    const id = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); rej(Object.assign(new Error("aborted"), { aborted: true })); }, { once: true });
  });
  const online = (signal) => new Promise((res, rej) => {
    if (navigator.onLine !== false) return res();
    const on = () => { window.removeEventListener("online", on); res(); };
    window.addEventListener("online", on);
    signal?.addEventListener("abort", () => { window.removeEventListener("online", on); rej(Object.assign(new Error("aborted"), { aborted: true })); }, { once: true });
  });

  function xhr(method, url, headers, body, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      if (onProgress && x.upload) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
      x.onload = () => resolve({ status: x.status, get: (h) => x.getResponseHeader(h), text: x.responseText });
      x.onerror = () => reject(Object.assign(new Error("network"), { network: true }));
      x.ontimeout = x.onerror;
      x.onabort = () => reject(Object.assign(new Error("aborted"), { aborted: true }));
      signal?.addEventListener("abort", () => x.abort(), { once: true });
      x.send(body ?? null);
    });
  }

  /* opts: { endpoint, headers, bucket, objectName, contentType, resumeKey, onProgress(bytesDone), signal } */
  async function upload(file, opts) {
    const base = { "Tus-Resumable": "1.0.0", ...opts.headers };
    let url = opts.resumeKey ? store.get(opts.resumeKey) : null;
    let offset = 0;

    const head = async () => {
      const r = await xhr("HEAD", url, base, null, null, opts.signal);
      if (r.status === 404 || r.status === 410 || r.status === 403) return null;
      if (r.status >= 300) throw Object.assign(new Error("head " + r.status), { status: r.status });
      return Number(r.get("Upload-Offset") || 0);
    };
    const create = async () => {
      const meta = [
        "bucketName " + b64(opts.bucket), "objectName " + b64(opts.objectName),
        "contentType " + b64(opts.contentType || file.type || "application/octet-stream"), "cacheControl " + b64("3600"),
      ].join(",");
      const r = await xhr("POST", opts.endpoint, { ...base, "Upload-Length": String(file.size), "Upload-Metadata": meta, "x-upsert": "false" }, null, null, opts.signal);
      if (r.status !== 201) throw Object.assign(new Error("create " + r.status), { status: r.status, fatal: r.status >= 400 && r.status < 500 && r.status !== 429 });
      const loc = r.get("Location");
      url = new URL(loc, opts.endpoint).href;
      if (opts.resumeKey) store.set(opts.resumeKey, url);
      offset = 0;
    };

    // resume or start
    if (url) { try { const o = await head(); if (o == null) url = null; else offset = o; } catch (e) { if (e.aborted) throw e; url = null; } }
    if (!url) await create();
    opts.onProgress?.(offset);

    let fails = 0;
    while (offset < file.size) {
      await online(opts.signal);
      const end = Math.min(offset + CHUNK, file.size);
      try {
        const r = await xhr("PATCH", url, { ...base, "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) },
          file.slice(offset, end), (loaded) => opts.onProgress?.(offset + loaded), opts.signal);
        if (r.status === 204 || r.status === 200) {
          offset = Number(r.get("Upload-Offset") || end); fails = 0; opts.onProgress?.(offset);
        } else if (r.status === 409) { // offset mismatch: ask the server where we are
          const o = await head(); if (o == null) { await create(); } else offset = o;
        } else if (r.status === 404 || r.status === 410) {
          store.del(opts.resumeKey || ""); await create();
        } else if (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408) {
          throw Object.assign(new Error("patch " + r.status), { fatal: true, status: r.status });
        } else throw Object.assign(new Error("patch " + r.status), { status: r.status });
      } catch (e) {
        if (e.aborted || e.fatal) throw e;
        if (++fails > 12) throw e;
        await sleep(Math.min(30000, 1000 * 2 ** Math.min(fails, 5)), opts.signal);
        try { const o = await head(); if (o != null) offset = o; } catch (e2) { if (e2.aborted) throw e2; }
      }
    }
    if (opts.resumeKey) store.del(opts.resumeKey);
    return { path: opts.objectName };
  }

  window.CD_TUS = { upload, CHUNK, fingerprint: (f) => [f.name, f.size, f.lastModified || 0].join("|") };
})();
