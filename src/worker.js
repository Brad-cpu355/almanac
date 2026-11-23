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
  if (segments[1] === "personal-email") return handlePersonalEmail(request, env, url, segments[2]);
  if (segments[1] === "school-email") return handleSchoolEmail(request, env, url, segments[2]);
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


/* Development-only manual Gmail scan. Never import without explicit approval.
 * Store only selected message metadata, not full message bodies or tokens.
 */
async function gmailAccessToken(env) {
  const row=await env.DB.prepare("SELECT encrypted_token FROM gmail_connection WHERE id=1").first();
  if (!row) throw new ValidationError("Connect Gmail first");
  const [iv, ciphertext]=row.encrypted_token.split(".");
  const raw=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64url(iv)},await gmailKey(env),unb64url(ciphertext));
  const saved=JSON.parse(new TextDecoder().decode(raw));
  const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:env.GMAIL_CLIENT_ID,client_secret:env.GMAIL_CLIENT_SECRET,
      refresh_token:saved.refresh_token,grant_type:"refresh_token"})});
  if(!response.ok) throw new ValidationError("Google access expired. Reconnect Gmail and try again.");
  const data=await response.json();
  if(!data.access_token) throw new ValidationError("Google did not return an access token");
  return data.access_token;
}
async function gmailRequest(token,path) {
  const response=await fetch("https://gmail.googleapis.com/gmail/v1/users/me/"+path,{
    headers:{authorization:"Bearer "+token,accept:"application/json"}});
  if(!response.ok) throw new Error("Gmail API returned "+response.status);
  return response.json();
}
async function ensureSchoolEmail(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS school_email_suggestions (
    message_id TEXT PRIMARY KEY, subject TEXT NOT NULL, sender TEXT NOT NULL,
    snippet TEXT NOT NULL, received_at INTEGER NOT NULL, child TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'other', due_date TEXT NOT NULL DEFAULT '',
    review_status TEXT NOT NULL DEFAULT 'pending', notice_id TEXT NOT NULL DEFAULT '',
    event_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  )`).run();
}
function classifySchoolEmail(subject,snippet) {
  const text=(subject+" "+snippet).toLowerCase();
  // Never surface potentially sensitive health, welfare, or safeguarding mail.
  if(/(hälsa|sjukdom|diagnos|kurator|elevhälsa|psykolog|specialpedagog|mobbn|health|medical|diagnos|counsell|safeguard|socialtjänst|frånvaro|absence)/i.test(text)) return null;
  const walter=/\bwalter\b/i.test(text), ingalill=/\bingalill\b/i.test(text);
  const child=walter&&!ingalill?"walter":ingalill&&!walter?"ingalill":"";
  const kind=/(prov|test|exam|tentamen)/i.test(text)?"exam":/(läxa|homework|inlämning|assignment)/i.test(text)?"homework":/(utflykt|aktivitet|activity|excursion|studiedag)/i.test(text)?"activity":/(föräldra|vårdnadshavare|parent|möte|meeting)/i.test(text)?"parent":"other";
  // Dates are intentionally left unconfirmed: snippets may contain several dates,
  // relative dates or dates referring to the message rather than the event.
  return {child,kind,dueDate:""};
}

/* Conservative extraction from already-stored subject/snippet metadata only.
 * Never infer relative dates, and never treat the received date as an event date.
 */
function suggestDateTime(subject, snippet, receivedAt) {
  const input=(subject+" "+(snippet||"")).slice(0,600);
  const monthNames={januari:1,februari:2,mars:3,april:4,maj:5,juni:6,juli:7,augusti:8,september:9,oktober:10,november:11,december:12,
    january:1,february:2,march:3,may:5,june:6,july:7,august:8,october:10,jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,sept:9,okt:10,oct:10,nov:11,dec:12,december:12};
  const candidates=[];
  const add=(y,m,d,source)=>{
    y=Number(y);m=Number(m);d=Number(d);
    if(y<100)y+=2000;
    const check=new Date(Date.UTC(y,m-1,d));
    if(check.getUTCFullYear()!==y||check.getUTCMonth()!==m-1||check.getUTCDate()!==d)return;
    candidates.push({date:String(y).padStart(4,"0")+"-"+String(m).padStart(2,"0")+"-"+String(d).padStart(2,"0"),source});
  };
  for(const m of input.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g))add(m[1],m[2],m[3],m[0]);
  for(const m of input.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g))add(m[3],m[2],m[1],m[0]);
  const receivedYear=new Date(Number(receivedAt)||Date.now()).getUTCFullYear();
  for(const m of input.matchAll(/\b(\d{1,2})\s+(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december|january|february|march|may|june|july|august|october|jan|feb|mar|apr|jun|jul|aug|sep|sept|okt|oct|nov|dec)\s*(20\d{2})?\b/gi))
    add(m[3]||receivedYear,monthNames[m[2].toLowerCase()],m[1],m[0]);
  // Relative expressions are anchored to the message received date, not scan date.
  // Received timestamps are a fallback for sent time; weekday boundaries near
  // midnight can be uncertain, so relative suggestions require verification.
  const anchor=new Date(Number(receivedAt)||Date.now());
  const relativeMatches=[];
  const relativeAdd=(days,label,confidence)=>{
    const target=new Date(Date.UTC(anchor.getUTCFullYear(),anchor.getUTCMonth(),anchor.getUTCDate()+days));
    relativeMatches.push({date:target.toISOString().slice(0,10),source:label,confidence});
  };
  for(const match of input.matchAll(/\b(idag|imorgon|i morgon|today|tomorrow)\b/gi)){
    const word=match[1].toLowerCase();
    relativeAdd(word==="idag"||word==="today"?0:1,match[0],"medium");
  }
  const weekdays={måndag:1,tisdag:2,onsdag:3,torsdag:4,fredag:5,lördag:6,söndag:0,
    monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,sunday:0};
  for(const match of input.matchAll(/\b(på|nästa|next|on)\s+(måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi)){
    const target=weekdays[match[2].toLowerCase()];
    let days=(target-anchor.getUTCDay()+7)%7;
    if(days===0)days=7;
    // "nästa fredag" can mean either the coming Friday or Friday next week.
    // Do not silently choose one interpretation.
    if(/^(nästa|next)$/i.test(match[1]))relativeMatches.push({date:"",source:match[0],confidence:"ambiguous"});
    else relativeAdd(days,match[0],"medium");
  }
  // A week number describes a range, not an individual event date.
  if(/\b(?:vecka|v\.|week)\s*\d{1,2}\b/i.test(input))
    relativeMatches.push({date:"",source:"week number",confidence:"ambiguous"});
  const unique=[...new Set(candidates.map(c=>c.date))];
  // Multiple distinct dates require human disambiguation.
  const relativeDates=[...new Set(relativeMatches.filter(r=>r.date).map(r=>r.date))];
  const conflict=unique.length>1 || relativeDates.length>1 || (unique.length===1&&relativeDates.some(d=>d!==unique[0]));
  const uncertain=relativeMatches.some(r=>r.confidence==="ambiguous");
  const date=!conflict&&unique.length===1?unique[0]:!conflict&&!uncertain&&relativeDates.length===1?relativeDates[0]:"";
  const confidence=conflict||uncertain?"ambiguous":unique.length===1?"high":date?"medium":"none";
  const times=[...input.matchAll(/\b(?:kl\.?|klockan|at)\s*(\d{1,2})[:.](\d{2})\b/gi)]
    .map(m=>String(Number(m[1])).padStart(2,"0")+":"+m[2]).filter(t=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t));
  const uniqueTimes=[...new Set(times)];
  const allDay=/\b(?:0?0[:.]00|00[:.]00)\s*[-–—]\s*23[:.]59\b/.test(input);
  return {date,time:allDay?"":uniqueTimes.length===1?uniqueTimes[0]:"",allDay,confidence,ambiguous:confidence==="ambiguous"||uniqueTimes.length>1,
    evidence:date?(candidates.find(c=>c.date===date)?.source||relativeMatches.find(r=>r.date===date)?.source||""):"",basis:snippet?"subject and preview":"subject only"};
}
/* On-demand, single-message body analysis. Content is never persisted or logged. */
function gmailBodyText(message) {
  const parts=[];
  function visit(part,depth) {
    if(depth>6 || parts.length>12)return;
    if(part.mimeType==="text/plain" && part.body?.data)parts.push(part.body.data);
    for(const child of part.parts||[])visit(child,depth+1);
  }
  visit(message.payload||{},0);
  if(!parts.length)return "";
  return parts.slice(0,4).map(encoded=>{
    try{
      const bytes=unb64url(encoded);
      return new TextDecoder("utf-8",{fatal:false}).decode(bytes.slice(0,24000));
    }catch{return "";}
  }).join("\n").slice(0,12000);
}
function verifiedSchoolSender(header) {
  const match=String(header||"").match(/<([^<>]+)>/) || String(header||"").match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const address=(match?.[1]||"").toLowerCase();
  const domain=address.split("@")[1]||"";
  return domain==="unikum.net"||domain.endsWith(".unikum.net")||domain==="malmo.se"||domain.endsWith(".malmo.se");
}
function schoolEmailRow(row) {
  return {id:row.message_id,subject:row.subject,sender:row.sender,snippet:row.snippet,
    receivedAt:row.received_at,child:row.child,kind:row.kind,dueDate:row.due_date,
    status:row.review_status,proposed:suggestDateTime(row.subject,row.snippet,row.received_at)};
}
async function handleSchoolEmail(request,env,url,action) {
  if(url.hostname!==GMAIL_PREVIEW_HOST||url.protocol!=="https:")return json({error:"Not available"},404);
  if(request.method!=="GET" && request.headers.get("origin")!=="https://"+GMAIL_PREVIEW_HOST)
    return json({error:"Invalid request origin"},403);
  await ensureSchoolEmail(env.DB);
  if(action==="suggestions" && request.method==="GET"){
    const {results}=await env.DB.prepare("SELECT * FROM school_email_suggestions ORDER BY received_at DESC LIMIT 100").all();
    return json(results.filter(r=>!r.sender.toLowerCase().includes("maria.rosenqvist@malmo.se")).map(schoolEmailRow));
  }
  if(action==="scan" && request.method==="POST"){
    const token=await gmailAccessToken(env);
    // Explicitly limit the query to school-service senders, not the full inbox.
    const query='newer_than:30d {from:(unikum.net) from:(malmo.se) from:(malmö.se)} -from:maria.rosenqvist@malmo.se';
    const list=await gmailRequest(token,"messages?"+new URLSearchParams({q:query,maxResults:"40"}));
    let added=0,skipped=0;
    for(const item of list.messages||[]){
      const existing=await env.DB.prepare("SELECT message_id FROM school_email_suggestions WHERE message_id=?").bind(item.id).first();
      if(existing){skipped++;continue;}
      const message=await gmailRequest(token,"messages/"+encodeURIComponent(item.id)+"?format=metadata&metadataHeaders=Subject&metadataHeaders=From");
      const headers=message.payload?.headers||[];
      const subject=(headers.find(h=>h.name.toLowerCase()==="subject")?.value||"").slice(0,160);
      const sender=(headers.find(h=>h.name.toLowerCase()==="from")?.value||"").slice(0,200);
      const snippet=(message.snippet||"").slice(0,300);
      if(sender.toLowerCase().includes("maria.rosenqvist@malmo.se")){skipped++;continue;}
      const classified=classifySchoolEmail(subject,snippet);
      if(!classified){skipped++;continue;}
      await env.DB.prepare(`INSERT OR IGNORE INTO school_email_suggestions
        (message_id,subject,sender,snippet,received_at,child,kind,due_date,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(item.id,subject,sender,snippet,
        Number(message.internalDate)||Date.now(),classified.child,classified.kind,"",Date.now()).run();
      added++;
    }
    return json({added,skipped,checked:(list.messages||[]).length});
  }
  if(action==="analyze" && request.method==="POST"){
    const body=await request.json();
    if(typeof body.id!=="string"||body.id.length>200)throw new ValidationError("Invalid suggestion");
    const row=await env.DB.prepare("SELECT * FROM school_email_suggestions WHERE message_id=? AND review_status='pending'").bind(body.id).first();
    if(!row)return json({error:"Pending suggestion not found"},404);
    if(!verifiedSchoolSender(row.sender)||row.sender.toLowerCase().includes("maria.rosenqvist@malmo.se"))
      return json({error:"This sender is not eligible for school email analysis"},403);
    // Only the explicitly selected message is fetched, never the entire inbox.
    const token=await gmailAccessToken(env);
    const message=await gmailRequest(token,"messages/"+encodeURIComponent(body.id)+"?format=full");
    const headers=message.payload?.headers||[];
    const actualSender=headers.find(h=>h.name.toLowerCase()==="from")?.value||"";
    if(!verifiedSchoolSender(actualSender)||actualSender.toLowerCase().includes("maria.rosenqvist@malmo.se"))
      return json({error:"Sender verification failed"},403);
    const actualSubject=(headers.find(h=>h.name.toLowerCase()==="subject")?.value||"").slice(0,160);
    const plain=gmailBodyText(message);
    if(!plain)return json({found:false,message:"No readable plain-text email body available. Use the existing subject/preview suggestion."});
    const sensitive=/(diagnos|psykolog|kurator|elevhälsa|sjukdom|therapy|therapist|medical|health|socialtjänst|safeguard)/i.test(actualSubject+" "+plain);
    if(sensitive)return json({found:false,message:"This email may contain sensitive information. Body analysis was skipped."});
    // Process up to 12k characters in memory; return only the proposed date/time.
    const proposed=suggestDateTime(actualSubject,plain,Number(message.internalDate)||row.received_at);
    return json({found:!!(proposed.date||proposed.time||proposed.allDay),proposed:{
      date:proposed.date,time:proposed.time,allDay:proposed.allDay,
      confidence:proposed.confidence,ambiguous:proposed.ambiguous,evidence:proposed.evidence,
      basis:"selected email body"
    }});
  }
  if(action==="review" && request.method==="POST"){
    const body=await request.json();
    if(typeof body.id!=="string"||body.id.length>200)throw new ValidationError("Invalid suggestion");
    const row=await env.DB.prepare("SELECT * FROM school_email_suggestions WHERE message_id=?").bind(body.id).first();
    if(!row) return json({error:"Suggestion not found"},404);
    if(row.sender.toLowerCase().includes("maria.rosenqvist@malmo.se"))return json({error:"Use Personal Email Inbox for this sender"},403);
    if(row.review_status!=="pending")return json({error:"Already reviewed"},409);
    if(body.decision==="dismiss"){
      await env.DB.prepare("UPDATE school_email_suggestions SET review_status='dismissed' WHERE message_id=? AND review_status='pending'").bind(body.id).run();
      return json({status:"dismissed"});
    }
    if(body.decision!=="approve")throw new ValidationError("Invalid decision");
    if(!["walter","ingalill"].includes(body.child))throw new ValidationError("Select Walter or Ingalill");
    const title=String(body.title||"").trim().slice(0,160);
    if(!title)throw new ValidationError("Enter a title");
    const date=String(body.date||"");
    if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new ValidationError("Invalid date");
    const kind=["exam","homework","activity","parent","other"].includes(body.kind)?body.kind:"other";
    const noticeId=crypto.randomUUID(),eventId=date?crypto.randomUUID():"";
    await ensureSchoolNotices(env.DB);
    // Guard against a double approval before creating calendar records.
    const claimed=await env.DB.prepare("UPDATE school_email_suggestions SET review_status='processing' WHERE message_id=? AND review_status='pending'").bind(body.id).run();
    if(!claimed.meta.changes)return json({error:"Already reviewed"},409);
    try{
      await env.DB.prepare("INSERT INTO school_notices (id,child,title,details,status,due_date,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(noticeId,body.child,title,"From reviewed school email: "+row.sender,"action",date,Date.now()).run();
      if(eventId){
        await env.DB.prepare("INSERT INTO events (id,title,date,time,category,recurring,notes,created_at) VALUES (?,?,?,?,?,?,?,?)")
          .bind(eventId,(body.child==="walter"?"[Walter · School] ":"[Ingalill · School] ")+title,date,"","family",0,"From approved school email",Date.now()).run();
        await env.DB.prepare("INSERT INTO school_notice_links (notice_id,event_id,record_type,source) VALUES (?,?,?,?)")
          .bind(noticeId,eventId,kind,"Gmail (reviewed)").run();
      }
      await env.DB.prepare("UPDATE school_email_suggestions SET review_status='approved',notice_id=?,event_id=?,child=?,due_date=?,kind=? WHERE message_id=?")
        .bind(noticeId,eventId,body.child,date,kind,body.id).run();
      return json({status:"approved",noticeId,eventId});
    }catch(e){
      await env.DB.prepare("UPDATE school_email_suggestions SET review_status='pending' WHERE message_id=? AND review_status='processing'").bind(body.id).run();
      throw e;
    }
  }
  return json({error:"Not found"},404);
}


/* Personal email review is opt-in, sender-specific, and metadata-only.
 * No message body, snippet or attachment is fetched or stored.
 */
const PERSONAL_SENDER="maria.rosenqvist@malmo.se";
async function ensurePersonalEmail(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS personal_email_suggestions (
    message_id TEXT PRIMARY KEY, subject TEXT NOT NULL, received_at INTEGER NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'pending', event_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`).run();
}
async function handlePersonalEmail(request,env,url,action){
  if(url.hostname!==GMAIL_PREVIEW_HOST||url.protocol!=="https:")return json({error:"Not available"},404);
  if(request.method!=="GET" && request.headers.get("origin")!=="https://"+GMAIL_PREVIEW_HOST)
    return json({error:"Invalid request origin"},403);
  await ensurePersonalEmail(env.DB);
  if(action==="suggestions" && request.method==="GET"){
    const {results}=await env.DB.prepare("SELECT message_id,subject,received_at,review_status FROM personal_email_suggestions ORDER BY received_at DESC LIMIT 100").all();
    return json(results.map(r=>({id:r.message_id,subject:r.subject,receivedAt:r.received_at,status:r.review_status,proposed:suggestDateTime(r.subject,"",r.received_at)})));
  }
  if(action==="scan" && request.method==="POST"){
    const token=await gmailAccessToken(env);
    const query="newer_than:30d from:"+PERSONAL_SENDER;
    const list=await gmailRequest(token,"messages?"+new URLSearchParams({q:query,maxResults:"40"}));
    let added=0,skipped=0;
    for(const item of list.messages||[]){
      const existing=await env.DB.prepare("SELECT message_id FROM personal_email_suggestions WHERE message_id=?").bind(item.id).first();
      if(existing){skipped++;continue;}
      const message=await gmailRequest(token,"messages/"+encodeURIComponent(item.id)+"?format=metadata&metadataHeaders=Subject&metadataHeaders=From");
      const headers=message.payload?.headers||[];
      const sender=(headers.find(h=>h.name.toLowerCase()==="from")?.value||"").toLowerCase();
      if(!sender.includes(PERSONAL_SENDER)){skipped++;continue;}
      const subject=(headers.find(h=>h.name.toLowerCase()==="subject")?.value||"(No subject)").slice(0,160);
      await env.DB.prepare("INSERT OR IGNORE INTO personal_email_suggestions (message_id,subject,received_at,created_at) VALUES (?,?,?,?)")
        .bind(item.id,subject,Number(message.internalDate)||Date.now(),Date.now()).run();
      added++;
    }
    return json({added,skipped,checked:(list.messages||[]).length});
  }
  if(action==="review" && request.method==="POST"){
    const body=await request.json();
    if(typeof body.id!=="string"||body.id.length>200)throw new ValidationError("Invalid suggestion");
    const row=await env.DB.prepare("SELECT review_status FROM personal_email_suggestions WHERE message_id=?").bind(body.id).first();
    if(!row)return json({error:"Suggestion not found"},404);
    if(row.review_status!=="pending")return json({error:"Already reviewed"},409);
    if(body.decision==="dismiss"){
      await env.DB.prepare("UPDATE personal_email_suggestions SET review_status='dismissed' WHERE message_id=? AND review_status='pending'").bind(body.id).run();
      return json({status:"dismissed"});
    }
    if(body.decision!=="approve")throw new ValidationError("Invalid decision");
    const title=String(body.title||"").trim().slice(0,160);
    const date=String(body.date||"");
    const time=String(body.time||"");
    if(!title)throw new ValidationError("Enter an event title");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+"T12:00:00")))throw new ValidationError("Confirm an event date");
    if(time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new ValidationError("Invalid time");
    const claimed=await env.DB.prepare("UPDATE personal_email_suggestions SET review_status='processing' WHERE message_id=? AND review_status='pending'").bind(body.id).run();
    if(!claimed.meta.changes)return json({error:"Already reviewed"},409);
    const eventId=crypto.randomUUID();
    try{
      await env.DB.prepare("INSERT INTO events (id,title,date,time,category,recurring,notes,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(eventId,title,date,time,"personal",0,"",Date.now()).run();
      await env.DB.prepare("UPDATE personal_email_suggestions SET review_status='approved',event_id=? WHERE message_id=?")
        .bind(eventId,body.id).run();
      return json({status:"approved",eventId});
    }catch(err){
      await env.DB.prepare("UPDATE personal_email_suggestions SET review_status='pending' WHERE message_id=? AND review_status='processing'").bind(body.id).run();
      throw err;
    }
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
