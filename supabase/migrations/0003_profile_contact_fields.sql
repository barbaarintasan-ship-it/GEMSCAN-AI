-- Adds the contact / location fields collected at sign-up (phone, country,
-- city) to public.profiles, and updates the signup trigger to copy them from
-- the new auth user's metadata (auth.signUp options.data) into the profile row.
--
-- The mobile client already stores these in the auth user's metadata at signup
-- (so they are captured even before this migration is applied); this migration
-- makes them queryable as first-class profile columns for admin/support views.

alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists country text;
alter table public.profiles add column if not exists city text;

-- Recreate the signup trigger function so newly created accounts populate the
-- new columns from raw_user_meta_data. Existing behaviour (id + email) is
-- unchanged; the extra fields are nullable so older clients that don't send
-- them still succeed.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, phone, country, city)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    nullif(new.raw_user_meta_data ->> 'country', ''),
    nullif(new.raw_user_meta_data ->> 'city', '')
  );
  return new;
end;
$$;
