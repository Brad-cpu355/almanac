-- Add optional inclusive end date for multi-day events.
ALTER TABLE events ADD COLUMN end_date TEXT DEFAULT NULL;
