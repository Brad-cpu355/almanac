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
    return json({ id, ...ev });
  }

  if (method === "DELETE" && id) {
    const result = await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
    if (result.meta.changes === 0) return json({ error: "Event not found" }, 404);
    return new Response(null, { status: 204 });
  }

  return json({ error: "Method not allowed" }, 405);
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
