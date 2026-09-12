-- "Found nothing" was the wrong thing to count.
--
-- Search runs precise first and, when that matches nothing, widens to an OR of
-- the terms — the two-pass behaviour that took recall from 75% to 93%. So it
-- practically never returns zero rows: a query about a subject Cairn has never
-- heard of came back with twenty loose matches on the day this was written.
--
-- The real signal is that widening happened at all. It means the precise
-- question had no answer, and whatever came back is the system guessing.

alter table search_events add column widened boolean not null default false;
