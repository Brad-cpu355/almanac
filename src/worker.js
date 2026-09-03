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
