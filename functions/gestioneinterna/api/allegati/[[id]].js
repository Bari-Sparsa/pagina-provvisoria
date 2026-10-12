// Il passacarte degli allegati delle reference (foto, video, documenti di ogni tipo). Li archivia nel OneDrive di Peppe,
// nella cartella dell'app (OneDrive → App → <nome dell'app>), e li ridà solo a chi è nella squadra: niente link pubblici.
//   GET  /gestioneinterna/api/allegati/stato     → {pronto, collega}: collega=true se manca solo il primo accesso
//   POST /gestioneinterna/api/allegati/collega   → {url}: il login Microsoft per collegare il OneDrive (una volta sola,
//        e solo finché non è collegato: per ricollegare si cancella la chiave `refresh` dal KV)
//   GET  /gestioneinterna/api/allegati/ritorno   → dove Microsoft rimanda dopo il login; salva la chiave nel KV
//   POST /gestioneinterna/api/allegati/sessione  → {nome, tipo} → {url}: il permesso per caricare UN file. Il browser lo
//        manda direttamente a OneDrive a pezzi da 10 MB (così non c'è il limite di 100 MB di Cloudflare); l'ultimo pezzo
//        risponde con l'id del file.
//   GET  /gestioneinterna/api/allegati/<id>      → il file
// Nelle impostazioni del progetto Cloudflare Pages: segreti MS_CLIENT_ID e MS_CLIENT_SECRET, e un KV legato col nome
// ARCHIVIO. La chiave di Microsoft cambia a ogni uso e dura 90 giorni dall'ultimo: per questo sta nel KV e non nei segreti.
// Il permesso è Files.ReadWrite.AppFolder: il passacarte vede solo la sua cartella, non il resto del OneDrive.
const SUPA = "https://ehclovlvospxfaappksk.supabase.co";
const CHIAVE = "sb_publishable_jf5dkgBhIwiTq9UUyy6zNQ_EY7Z1N9U"; // pubblica: i dati li protegge il database
const MS = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPE = "Files.ReadWrite.AppFolder offline_access";
const GRAPH = "https://graph.microsoft.com/v1.0/me/drive";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const ritorno = (request) => new URL(request.url).origin + "/gestioneinterna/api/allegati/ritorno";
const configurato = (env) => !!(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && env.ARCHIVIO);

// chi chiama deve avere un accesso valido ed essere in `squadra`: lo dice il database stesso
async function eSquadra(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const r = await fetch(SUPA + "/rest/v1/rpc/e_squadra", {
    method: "POST", headers: { apikey: CHIAVE, Authorization: auth, "Content-Type": "application/json" }, body: "{}",
  });
  return r.ok && (await r.json()) === true;
}

async function chiave(env, corpo) {
  const r = await fetch(MS + "/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: SCOPE, ...corpo }),
  });
  if (!r.ok) throw new Error("microsoft " + r.status + " " + (await r.text()));
  const j = await r.json();
  if (j.refresh_token) await env.ARCHIVIO.put("refresh", j.refresh_token);
  return j;
}

// ponytail: l'accesso resta in memoria finché Cloudflare tiene vivo il processo; se riparte lo richiede
let token = null, scade = 0;
async function microsoft(env) {
  if (token && Date.now() < scade) return token;
  const refresh = await env.ARCHIVIO.get("refresh");
  if (!refresh) throw new Error("OneDrive non collegato");
  const j = await chiave(env, { grant_type: "refresh_token", refresh_token: refresh });
  token = j.access_token; scade = Date.now() + (j.expires_in - 60) * 1000;
  return token;
}

export async function onRequestGet({ request, env, params }) {
  const id = (params.id || [])[0] || "";
  if (id === "stato") {
    if (!configurato(env)) return json({ pronto: false });
    const c = !!(await env.ARCHIVIO.get("refresh"));
    return json({ pronto: c, collega: !c });
  }
  if (id === "ritorno") {
    const u = new URL(request.url), st = u.searchParams.get("state") || "";
    const torna = (msg) => Response.redirect(u.origin + "/gestioneinterna/?onedrive=" + encodeURIComponent(msg), 302);
    if (!configurato(env) || !st || !(await env.ARCHIVIO.get("stato:" + st))) return torna("link scaduto, riprova");
    await env.ARCHIVIO.delete("stato:" + st);
    if (!u.searchParams.get("code")) return torna(u.searchParams.get("error_description") || "accesso annullato");
    try {
      await chiave(env, { grant_type: "authorization_code", code: u.searchParams.get("code"), redirect_uri: ritorno(request) });
      return torna("collegato");
    } catch (e) {
      return torna(String(e.message || e).slice(0, 200));
    }
  }
  if (!/^[A-Za-z0-9!_.-]{5,200}$/.test(id)) return json({ errore: "id" }, 400);
  if (!(await eSquadra(request))) return json({ errore: "non sei nella squadra" }, 403);
  try {
    // Microsoft risponde con un rimando al file vero, e fetch lo segue da solo
    const r = await fetch(`${GRAPH}/items/${encodeURIComponent(id)}/content`, { headers: { Authorization: "Bearer " + (await microsoft(env)) } });
    if (!r.ok) return json({ errore: r.status === 404 ? "non è più su OneDrive" : "onedrive " + r.status }, r.status === 404 ? 404 : 502);
    const h = { "Content-Type": r.headers.get("Content-Type") || "application/octet-stream", "Cache-Control": "private, max-age=604800" };
    if (r.headers.get("Content-Length")) h["Content-Length"] = r.headers.get("Content-Length");
    return new Response(r.body, { headers: h });
  } catch (e) {
    return json({ errore: String(e.message || e) }, 502);
  }
}

export async function onRequestPost({ request, env, params }) {
  const cosa = (params.id || [])[0];
  if (cosa !== "sessione" && cosa !== "collega") return json({ errore: "indirizzo" }, 404);
  if (!(await eSquadra(request))) return json({ errore: "non sei nella squadra" }, 403);
  if (!configurato(env)) return json({ errore: "manca la configurazione" }, 503);

  if (cosa === "collega") {
    if (await env.ARCHIVIO.get("refresh")) return json({ errore: "già collegato" }, 409);
    const st = crypto.randomUUID();
    await env.ARCHIVIO.put("stato:" + st, "1", { expirationTtl: 600 });
    const q = new URLSearchParams({ client_id: env.MS_CLIENT_ID, response_type: "code", redirect_uri: ritorno(request), scope: SCOPE, state: st, prompt: "select_account" });
    return json({ url: MS + "/authorize?" + q });
  }

  let d;
  try { d = await request.json(); } catch (e) { return json({ errore: "richiesta" }, 400); }
  // OneDrive non vuole questi caratteri nei nomi
  const nome = String(d.nome || "allegato").replace(/[\u0000-\u001f"*:<>?\/\\|#%]/g, "-").trim().slice(0, 120) || "allegato";
  try {
    const r = await fetch(`${GRAPH}/special/approot:/${encodeURIComponent(nome)}:/createUploadSession`, {
      method: "POST",
      headers: { Authorization: "Bearer " + (await microsoft(env)), "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
    });
    if (!r.ok) throw new Error("onedrive " + r.status + " " + (await r.text()));
    return json({ url: (await r.json()).uploadUrl });
  } catch (e) {
    return json({ errore: String(e.message || e) }, 502);
  }
}
