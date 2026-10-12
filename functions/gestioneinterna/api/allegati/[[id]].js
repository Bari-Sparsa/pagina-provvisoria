// Il passacarte degli allegati delle reference (foto, video, documenti di ogni tipo). Li archivia nel Drive della squadra
// e li ridà solo a chi è nella squadra: il Drive resta privato, niente link pubblici.
//   GET  /gestioneinterna/api/allegati/stato     → {pronto}: se il collegamento a Google c'è
//   POST /gestioneinterna/api/allegati/sessione  → {nome, tipo, mini} → {url}: il permesso per caricare UN file.
//        Il file lo manda il browser direttamente a Google con un PUT su quell'url (così non c'è il limite di 100 MB
//        di Cloudflare); la risposta di Google al PUT dà l'id del file.
//   GET  /gestioneinterna/api/allegati/<id>      → il file
// Segreti nelle variabili del progetto Cloudflare Pages: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.
// Il permesso Google è drive.file: il passacarte vede solo i file che ha creato lui, non il resto del Drive.
const SUPA = "https://ehclovlvospxfaappksk.supabase.co";
const CHIAVE = "sb_publishable_jf5dkgBhIwiTq9UUyy6zNQ_EY7Z1N9U"; // pubblica: i dati li protegge il database
const CARTELLA = "Bari Sparsa - Reference";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

// chi chiama deve avere un accesso valido ed essere in `squadra`: lo dice il database stesso
async function eSquadra(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const r = await fetch(SUPA + "/rest/v1/rpc/e_squadra", {
    method: "POST", headers: { apikey: CHIAVE, Authorization: auth, "Content-Type": "application/json" }, body: "{}",
  });
  return r.ok && (await r.json()) === true;
}

// ponytail: token e cartelle restano in memoria finché Cloudflare tiene vivo il processo; se riparte li richiede
let token = null, scade = 0;
const cartelle = {};
async function google(env) {
  if (token && Date.now() < scade) return token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error("google " + r.status + " " + (await r.text()));
  const j = await r.json();
  token = j.access_token; scade = Date.now() + (j.expires_in - 60) * 1000;
  return token;
}
async function cartella(t, nome, padre) {
  const k = nome + "|" + (padre || "");
  if (cartelle[k]) return cartelle[k];
  const q = `name='${nome}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (padre ? ` and '${padre}' in parents` : "");
  const l = await fetch("https://www.googleapis.com/drive/v3/files?fields=files(id)&q=" + encodeURIComponent(q), { headers: { Authorization: "Bearer " + t } });
  if (!l.ok) throw new Error("drive " + l.status);
  const trovate = (await l.json()).files || [];
  if (trovate.length) return (cartelle[k] = trovate[0].id);
  const c = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
    body: JSON.stringify({ name: nome, mimeType: "application/vnd.google-apps.folder", parents: padre ? [padre] : undefined }),
  });
  if (!c.ok) throw new Error("drive " + c.status);
  return (cartelle[k] = (await c.json()).id);
}

export async function onRequestGet({ request, env, params }) {
  const id = (params.id || [])[0] || "";
  if (id === "stato") return json({ pronto: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) });
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return json({ errore: "id" }, 400);
  if (!(await eSquadra(request))) return json({ errore: "non sei nella squadra" }, 403);
  try {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: "Bearer " + (await google(env)) } });
    if (!r.ok) return json({ errore: r.status === 404 ? "non è più sul Drive" : "drive " + r.status }, r.status === 404 ? 404 : 502);
    const h = { "Content-Type": r.headers.get("Content-Type") || "application/octet-stream", "Cache-Control": "private, max-age=604800" };
    if (r.headers.get("Content-Length")) h["Content-Length"] = r.headers.get("Content-Length");
    return new Response(r.body, { headers: h });
  } catch (e) {
    return json({ errore: String(e.message || e) }, 502);
  }
}

export async function onRequestPost({ request, env, params }) {
  if ((params.id || [])[0] !== "sessione") return json({ errore: "indirizzo" }, 404);
  if (!(await eSquadra(request))) return json({ errore: "non sei nella squadra" }, 403);
  let d;
  try { d = await request.json(); } catch (e) { return json({ errore: "richiesta" }, 400); }
  const nome = String(d.nome || "allegato").replace(/[\u0000-\u001f\/\\]/g, "").slice(0, 120) || "allegato";
  const tipo = /^[\w.+-]+\/[\w.+-]+$/.test(d.tipo || "") ? d.tipo : "application/octet-stream";
  try {
    const t = await google(env), su = await cartella(t, CARTELLA), dove = d.mini ? await cartella(t, "miniature", su) : su;
    // l'Origin dice a Google da che sito arriverà il PUT, così il browser può caricare direttamente
    const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,mimeType", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + t, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": tipo,
        Origin: request.headers.get("Origin") || new URL(request.url).origin,
      },
      body: JSON.stringify({ name: nome, parents: [dove] }),
    });
    if (!r.ok || !r.headers.get("Location")) throw new Error("drive " + r.status + " " + (await r.text()));
    return json({ url: r.headers.get("Location") });
  } catch (e) {
    return json({ errore: String(e.message || e) }, 502);
  }
}
