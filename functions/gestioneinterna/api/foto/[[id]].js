// Il passacarte delle foto delle reference. La dashboard gliele manda, lui le archivia nel Drive della squadra
// e le ridà solo a chi è nella squadra (il Drive resta privato, niente link pubblici).
//   GET  /gestioneinterna/api/foto/stato  → {pronto}: se il collegamento a Google c'è
//   POST /gestioneinterna/api/foto        → form con «foto» (grande) e «mini» (miniatura) → {id, mini}
//   GET  /gestioneinterna/api/foto/<id>   → la foto
// Segreti nelle variabili del progetto Cloudflare Pages: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.
// Il permesso Google è drive.file: il passacarte vede solo i file che ha creato lui, non il resto del Drive.
const SUPA = "https://ehclovlvospxfaappksk.supabase.co";
const CHIAVE = "sb_publishable_jf5dkgBhIwiTq9UUyy6zNQ_EY7Z1N9U"; // pubblica: i dati li protegge il database
const CARTELLA = "Bari Sparsa - Reference";
const MAX = 8 * 1024 * 1024;

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
async function caricaFile(t, padre, file, nome) {
  const b = "passacarte" + crypto.randomUUID();
  const body = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: nome, parents: [padre] })}\r\n`,
    `--${b}\r\nContent-Type: ${file.type || "image/jpeg"}\r\n\r\n`, await file.arrayBuffer(), `\r\n--${b}--`,
  ]);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": `multipart/related; boundary=${b}` }, body,
  });
  if (!r.ok) throw new Error("drive " + r.status + " " + (await r.text()));
  return (await r.json()).id;
}

export async function onRequestGet({ request, env, params }) {
  const id = (params.id || [])[0] || "";
  if (id === "stato") return json({ pronto: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) });
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return json({ errore: "id" }, 400);
  if (!(await eSquadra(request))) return json({ errore: "non sei nella squadra" }, 403);
  try {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: "Bearer " + (await google(env)) } });
    if (!r.ok) return json({ errore: r.status === 404 ? "non è più sul Drive" : "drive " + r.status }, r.status === 404 ? 404 : 502);
    return new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "private, max-age=604800" } });
  } catch (e) {
    return json({ errore: String(e.message || e) }, 502);
  }
}

export async function onRequestPost({ request, env, params }) {
  if ((params.id || []).length) return json({ errore: "indirizzo" }, 404);
  if (!(await eSquadra(request))) return json({ errore: "non sei nella squadra" }, 403);
  const form = await request.formData();
  const foto = form.get("foto"), mini = form.get("mini"), nome = String(form.get("nome") || "foto").replace(/[^\w .()-]/g, "").slice(0, 80) || "foto";
  for (const f of [foto, mini]) {
    if (!(f instanceof File) || !/^image\//.test(f.type) || f.size > MAX) return json({ errore: "serve un'immagine sotto gli 8 MB" }, 400);
  }
  try {
    const t = await google(env), su = await cartella(t, CARTELLA), giu = await cartella(t, "miniature", su);
    const [id, idMini] = await Promise.all([caricaFile(t, su, foto, nome + ".jpg"), caricaFile(t, giu, mini, nome + " (miniatura).jpg")]);
    return json({ id, mini: idMini });
  } catch (e) {
    return json({ errore: String(e.message || e) }, 502);
  }
}
