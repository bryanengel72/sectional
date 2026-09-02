-- Extra expense lines from the product brief: tolls (per driven mile; IFTA,
-- permits and parking can be folded in) and a user-defined per-load cost.
alter table public.driver_profiles
  add column if not exists toll_per_mile numeric not null default 0.03,
  add column if not exists other_per_load numeric not null default 0;
