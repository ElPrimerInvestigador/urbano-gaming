-- Migration: 0053_create_venues
-- Soccer Predictions. A physical location whose own coordinates are
-- the authority a submitted Prediction's geolocation evidence (0056)
-- is checked against. No partner CRM, no Lifestyle ID. Unchanged by
-- the Founder's dimension-model correction — manual Venue selection
-- is explicitly accepted for v1; nearby-Venue auto-discovery is a
-- recorded future direction only (see the implementation record).

create table venues (
  venue_id uuid primary key default gen_random_uuid(),
  name text not null,
  latitude numeric(9, 6) not null,
  longitude numeric(9, 6) not null,
  radius_meters numeric not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table venues
  add constraint venues_name_not_empty check (char_length(btrim(name)) >= 1);
alter table venues
  add constraint venues_latitude_range check (latitude between -90 and 90);
alter table venues
  add constraint venues_longitude_range check (longitude between -180 and 180);
alter table venues
  add constraint venues_radius_positive check (radius_meters > 0);
