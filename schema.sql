-- Almanac event store.
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,             -- 'YYYY-MM-DD', the original/first date
  time        TEXT NOT NULL DEFAULT '',  -- 'HH:MM' 24h, or '' if all-day
  category    TEXT NOT NULL DEFAULT 'other', -- personal | work | family | birthday | other
  recurring   INTEGER NOT NULL DEFAULT 0,    -- 1 = repeats every year on month/day
  notes       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL           -- epoch millis
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
