/**
 * Almanac worker.
 *
 * Everything except /api/* is served directly from the `public/` static
 * assets (see wrangler.toml's [assets] block with run_worker_first) — this
 * file only ever runs for the JSON API that reads and writes the D1
 * `events` table.
 *
 * Access control (who may reach this Worker at all) is handled outside
 * this code, by putting a Cloudflare Zero Trust Access application in
 * front of the route — see README.md. There is no login flow in here on
 * purpose.
 */

const CATEGORIES = new Set(["personal", "work", "family", "birthday", "other"]);

class ValidationError extends Error {}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        if (err instanceof ValidationError) {
          return json({ error: err.message }, 400);
        }
        console.error("Almanac API error:", err);
        return json({ error: "Internal error" }, 500);
      }
    }
    // Fallback for anything the assets binding didn't already serve.
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const segments = url.pathname.split("/").filter(Boolean); // ["api", "events", id?]
  if (segments[1] === "auth" && segments[2] === "google") return handleGoogleAuth(request, env, url, segments[3]);
  if (segments[1] === "school-notices") return handleSchoolNotices(request, env, segments[2]);
  if (segments[1] !== "events") return json({ error: "Not found" }, 404);

  const id = segments[2];
  const { method } = request;

  if (method === "GET" && !id) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM events ORDER BY date ASC"
    ).all();
    return json(results.map(rowToEvent));
  }

  if (method === "POST" && !id) {
    const ev = normalize(await request.json());
    const newId = crypto.randomUUID();
    const createdAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO events (id, title, date, time, category, recurring, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(newId, ev.title, ev.date, ev.time, ev.category, ev.recurring ? 1 : 0, ev.notes, createdAt)
      .run();
    return json({ id: newId, ...ev, createdAt }, 201);
  }

  if (method === "PUT" && id) {
    const ev = normalize(await request.json());
    const result = await env.DB.prepare(
      `UPDATE events SET title = ?, date = ?, time = ?, category = ?, recurring = ?, notes = ?
       WHERE id = ?`
    )
      .bind(ev.title, ev.date, ev.time, ev.category, ev.recurring ? 1 : 0, ev.notes, id)
      .run();
    if (result.meta.changes === 0) return json({ error: "Event not found" }, 404);
    // Keep the linked notice date consistent when a calendar event is edited.
    // Preserve the notice status, title, and details.
    await ensureSchoolNotices(env.DB);
    await env.DB.prepare(
      "UPDATE school_notices SET due_date=? WHERE id IN (SELECT notice_id FROM school_notice_links WHERE event_id=?)"
    ).bind(ev.date,id).run();
    return json({ id, ...ev });
  }

  if (method === "DELETE" && id) {
    const result = await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
    if (result.meta.changes === 0) return json({ error: "Event not found" }, 404);
    await ensureSchoolNotices(env.DB);
    await env.DB.prepare("DELETE FROM school_notice_links WHERE event_id=?").bind(id).run();
    return new Response(null, { status: 204 });
  }

  return json({ error: "Method not allowed" }, 405);
}



/* Gmail OAuth is available only on the explicitly named development preview.
 * Cloudflare Access must protect that hostname, including /api/*.
 * Never expose OAuth credentials or tokens in JSON responses or logs.
 */
const GMAIL_PREVIEW_HOST = "feature-school-family-calendar-almanac.brad11man.workers.dev";
const GMAIL_REDIRECT = "https://" + GMAIL_PREVIEW_HOST + "/api/auth/google/callback";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const encoder = new TextEncoder();
function b64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).split("+").join("-").split("/").join("_").replace(/=+$/g, "");
}
function unb64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function gmailKey(env) {
  if (!env.GMAIL_TOKEN_KEY) throw new Error("Gmail encryption key not configured");
  const keyBytes = unb64url(env.GMAIL_TOKEN_KEY);
  if (keyBytes.length !== 32) throw new Error("Gmail encryption key must contain 32 bytes");
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptGmail(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:"AES-GCM",iv}, await gmailKey(env), encoder.encode(value));
  return b64url(iv) + "." + b64url(new Uint8Array(encrypted));
}
async function ensureGmailTables(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS gmail_oauth_state (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS gmail_connection (id INTEGER PRIMARY KEY CHECK (id=1), encrypted_token TEXT NOT NULL, connected_at INTEGER NOT NULL)").run();
}
function gmailHtml(message, ok) {
  const safe = message.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Almanac Gmail</title><body style="font-family:sans-serif;max-width:36rem;margin:4rem auto"><h1>Almanac Gmail</h1><p>'+safe+'</p><p><a href="/">Return to Almanac</a></p></body></html>', {status:ok?200:400,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer"}});
}
async function handleGoogleAuth(request, env, url, action) {
  if (url.hostname !== GMAIL_PREVIEW_HOST || url.protocol !== "https:") return json({error:"Not available on this deployment"},404);
  if (!["GET","POST"].includes(request.method)) return json({error:"Method not allowed"},405);
  const configured = !!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_TOKEN_KEY);
  if (action === "status" && request.method === "GET") {
    if (!configured) return json({configured:false,connected:false});
    await ensureGmailTables(env.DB);
    const record = await env.DB.prepare("SELECT connected_at FROM gmail_connection WHERE id=1").first();
    return json({configured:true,connected:!!record,connectedAt:record?.connected_at||null});
  }
  if (!configured) return json({error:"Gmail credentials are not configured"},503);
  if (action === "start" && request.method === "GET") {
    // Temporary preview-only diagnostics: disclose only a fixed stage label,
    // never exception text, SQL parameters, OAuth state, tokens or secrets.
    let stage = "create_tables";
    try {
      await ensureGmailTables(env.DB);
      stage = "generate_state";
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
      stage = "remove_expired_state";
      await env.DB.prepare("DELETE FROM gmail_oauth_state WHERE expires_at<?").bind(Date.now()).run();
      stage = "save_state";
      await env.DB.prepare("INSERT INTO gmail_oauth_state (nonce,expires_at) VALUES (?,?)").bind(nonce,Date.now()+600000).run();
      stage = "build_redirect";
      const params = new URLSearchParams({
        client_id:env.GMAIL_CLIENT_ID,redirect_uri:GMAIL_REDIRECT,response_type:"code",
        scope:GMAIL_SCOPE,access_type:"offline",prompt:"consent",state:nonce
      });
      return new Response(null,{status:302,headers:{
        "location":"https://accounts.google.com/o/oauth2/v2/auth?"+params,
        "set-cookie":"almanac_gmail_state="+nonce+"; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
        "cache-control":"no-store","referrer-policy":"no-referrer"
      }});
    } catch (error) {
      console.error("Gmail OAuth start failed at stage:", stage, error?.name || "Error");
      return json({error:"Gmail connection could not start",diagnostic_stage:stage},500);
    }
  }
  if (action === "callback" && request.method === "GET") {
    const clearCookie="almanac_gmail_state=; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
    const fail=(message)=>{const response=gmailHtml(message,false);response.headers.set("set-cookie",clearCookie);return response;};
    if (url.searchParams.has("error")) return fail("Google did not authorise the connection.");
    const state=url.searchParams.get("state")||"";
    const cookie=(request.headers.get("cookie")||"").split(";").map(v=>v.trim()).find(v=>v.startsWith("almanac_gmail_state="));
    if (!state || !cookie || cookie.slice("almanac_gmail_state=".length)!==state) return fail("The sign-in session expired or did not match. Please try again.");
    await ensureGmailTables(env.DB);
    const saved=await env.DB.prepare("SELECT expires_at FROM gmail_oauth_state WHERE nonce=?").bind(state).first();
    if (!saved || saved.expires_at<Date.now()) return fail("The sign-in session expired. Please try again.");
    await env.DB.prepare("DELETE FROM gmail_oauth_state WHERE nonce=?").bind(state).run();
    const code=url.searchParams.get("code");
    if (!code) return fail("Google did not return an authorisation code.");
    const tokenResponse=await fetch("https://oauth2.googleapis.com/token",{
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({code,client_id:env.GMAIL_CLIENT_ID,client_secret:env.GMAIL_CLIENT_SECRET,redirect_uri:GMAIL_REDIRECT,grant_type:"authorization_code"})
    });
    if (!tokenResponse.ok) return fail("Google could not complete the connection. Check the OAuth configuration.");
    const token=await tokenResponse.json();
    if (!token.refresh_token) return fail("Google did not provide an offline refresh token. Please retry the connection.");
    const encrypted=await encryptGmail(env,JSON.stringify({refresh_token:token.refresh_token,scope:token.scope||"",token_type:token.token_type||""}));
    await env.DB.prepare("INSERT INTO gmail_connection (id,encrypted_token,connected_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET encrypted_token=excluded.encrypted_token,connected_at=excluded.connected_at").bind(encrypted,Date.now()).run();
    const response=gmailHtml("Gmail connected with read-only permission. No messages have been imported.",true);
    response.headers.set("set-cookie",clearCookie);
    return response;
  }
  if (action === "disconnect" && request.method === "POST") {
    if (request.headers.get("origin") !== "https://"+GMAIL_PREVIEW_HOST) return json({error:"Invalid request origin"},403);
    await ensureGmailTables(env.DB);
    // Disconnect locally; revoke Google access separately in Google Account settings if desired.
    await env.DB.prepare("DELETE FROM gmail_connection WHERE id=1").run();
    return json({connected:false});
  }
  return json({error:"Not found"},404);
}

const NOTICE_CHILDREN = new Set(["walter", "ingalill"]);
const NOTICE_STATUSES = new Set(["action", "upcoming", "completed"]);
async function ensureSchoolNotices(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS school_notices (
    id TEXT PRIMARY KEY, child TEXT NOT NULL, title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'action',
    due_date TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS school_notice_settings (
    setting TEXT PRIMARY KEY, value TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS school_notice_links (
    notice_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    record_type TEXT NOT NULL DEFAULT 'other',
    source TEXT NOT NULL DEFAULT 'manual'
  )`).run();
  const seed = await db.prepare("SELECT value FROM school_notice_settings WHERE setting = 'initial_seed'").first();
  if (!seed) {
    const starter = [
      ["walter","Mathematics exam — Chapter 2","27 November 2026","upcoming","2026-11-27"],
      ["walter","Confirm Spanish and personal finance assessments","Check dates and outcomes","action",""],
      ["walter","Confirm mother-tongue application decision","","action",""],
      ["ingalill","Confirm mathematics exam date","Exam announced; date not confirmed","action",""],
      ["ingalill","Follow up on reading homework","","action",""]
    ];
    const statements = starter.map(([child,title,details,status,due]) =>
      db.prepare("INSERT OR IGNORE INTO school_notices (id,child,title,details,status,due_date,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind("starter-"+child+"-"+title.toLowerCase().replace(/[^a-z0-9]+/g,"-"),child,title,details,status,due,Date.now())
    );
    statements.push(db.prepare("INSERT OR IGNORE INTO school_notice_settings (setting,value) VALUES ('initial_seed','1')"));
    await db.batch(statements);
  }
}
function normalizeSchoolNotice(body) {
  if (!body || !NOTICE_CHILDREN.has(body.child)) throw new ValidationError("Choose Walter or Ingalill");
  const title = typeof body.title === "string" ? body.title.trim().slice(0,160) : "";
  if (!title) throw new ValidationError("Notice title is required");
  const due = typeof body.dueDate === "string" ? body.dueDate.trim() : "";
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new ValidationError("Invalid date");
  const linkedEventId = typeof body.linkedEventId === "string" ? body.linkedEventId.trim() : "";
  const recordType = ["exam","homework","activity","parent","other"].includes(body.recordType) ? body.recordType : "other";
  const source = typeof body.source === "string" ? body.source.trim().slice(0,160) : "manual";
  return { linkedEventId, recordType, source, child:body.child, title, details:typeof body.details === "string" ? body.details.trim().slice(0,1000) : "",
    status:NOTICE_STATUSES.has(body.status) ? body.status : "action", dueDate:due };
}
function noticeFromRow(row) {
  return {id:row.id,child:row.child,title:row.title,details:row.details,status:row.status,dueDate:row.due_date,
    linkedEventId:row.event_id || "",recordType:row.record_type || "other",source:row.source || "manual"};
}
async function validateNoticeLink(db,id,n){
  if(!n.linkedEventId)return;
  const ev=await db.prepare("SELECT title FROM events WHERE id=?").bind(n.linkedEventId).first();
  const prefix=n.child==="walter"?"[Walter · School] ":"[Ingalill · School] ";
  if(!ev||!ev.title.startsWith(prefix))throw new ValidationError("Select a school event belonging to the same child");
  const existing=await db.prepare("SELECT notice_id FROM school_notice_links WHERE event_id=? AND notice_id<>?").bind(n.linkedEventId,id).first();
  if(existing)throw new ValidationError("This event is already linked to another notice");
}
async function saveNoticeLink(db,id,n){
  if(!n.linkedEventId){
    await db.prepare("DELETE FROM school_notice_links WHERE notice_id=?").bind(id).run();return;
  }
  await db.prepare("INSERT INTO school_notice_links (notice_id,event_id,record_type,source) VALUES (?,?,?,?) ON CONFLICT(notice_id) DO UPDATE SET event_id=excluded.event_id,record_type=excluded.record_type,source=excluded.source")
    .bind(id,n.linkedEventId,n.recordType,n.source).run();
}
async function handleSchoolNotices(request, env, id) {
  await ensureSchoolNotices(env.DB);
  if (request.method === "GET" && !id) {
    const {results} = await env.DB.prepare("SELECT n.*,l.event_id,l.record_type,l.source FROM school_notices n LEFT JOIN school_notice_links l ON l.notice_id=n.id ORDER BY CASE n.status WHEN 'completed' THEN 1 ELSE 0 END,n.due_date,n.created_at").all();
    return json(results.map(noticeFromRow));
  }
  if (request.method === "POST" && !id) {
    const n = normalizeSchoolNotice(await request.json());
    const noticeId = crypto.randomUUID();
    await validateNoticeLink(env.DB,noticeId,n);
    await env.DB.prepare("INSERT INTO school_notices (id,child,title,details,status,due_date,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(noticeId,n.child,n.title,n.details,n.status,n.dueDate,Date.now()).run();
    await saveNoticeLink(env.DB,noticeId,n);
    return json({id:noticeId,...n},201);
  }
  if (request.method === "PUT" && id) {
    const n = normalizeSchoolNotice(await request.json());
    await validateNoticeLink(env.DB,id,n);
    const result = await env.DB.prepare("UPDATE school_notices SET child=?,title=?,details=?,status=?,due_date=? WHERE id=?")
      .bind(n.child,n.title,n.details,n.status,n.dueDate,id).run();
    if(result.meta.changes){
      await saveNoticeLink(env.DB,id,n);
      // The notice owns status; the linked event owns its calendar appearance.
      // A dated notice may update its linked event date, without changing the title.
      if(n.linkedEventId && n.dueDate){
        await env.DB.prepare("UPDATE events SET date=? WHERE id=?").bind(n.dueDate,n.linkedEventId).run();
      }
    }
    return result.meta.changes ? json({id,...n}) : json({error:"Notice not found"},404);
  }
  if (request.method === "DELETE" && id) {
    await env.DB.prepare("DELETE FROM school_notice_links WHERE notice_id=?").bind(id).run();
    const result = await env.DB.prepare("DELETE FROM school_notices WHERE id=?").bind(id).run();
    return result.meta.changes ? new Response(null,{status:204}) : json({error:"Notice not found"},404);
  }
  return json({error:"Method not allowed"},405);
}

function normalize(body) {
  if (!body || typeof body.title !== "string" || !body.title.trim()) {
    throw new ValidationError("Title is required");
  }
  if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    throw new ValidationError("Date must be in YYYY-MM-DD form");
  }
  const category = CATEGORIES.has(body.category) ? body.category : "other";
  const time = typeof body.time === "string" && /^\d{2}:\d{2}$/.test(body.time) ? body.time : "";
  return {
    title: body.title.trim().slice(0, 120),
    date: body.date,
    time,
    category,
    recurring: !!body.recurring,
    notes: typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "",
  };
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    time: row.time,
    category: row.category,
    recurring: !!row.recurring,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
