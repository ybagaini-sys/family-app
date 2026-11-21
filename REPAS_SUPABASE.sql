-- FAMILY-APP | Module Repas V1.12
-- Planning hebdomadaire modifiable + absences individuelles sans motif.
-- Migration additive : ne supprime aucune donnée existante.

begin;

-- Un repas peut être planifié ou signalé comme "aucun repas prévu".
alter table public.meal_entries
  add column if not exists is_planned boolean not null default true;

-- Une ligne n'est créée que pour une absence.
-- L'absence de ligne signifie que le membre est présent par défaut.
create table if not exists public.meal_attendance (
  id uuid primary key default gen_random_uuid(),
  meal_entry_id uuid not null
    references public.meal_entries(id) on delete cascade,
  family_id uuid not null
    references public.families(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  is_present boolean not null default false,
  created_at timestamptz not null default now(),
  constraint meal_attendance_unique_member
    unique (meal_entry_id, user_id)
);

create index if not exists meal_attendance_family_idx
  on public.meal_attendance(family_id);
create index if not exists meal_attendance_meal_idx
  on public.meal_attendance(meal_entry_id);

create or replace function public.validate_meal_attendance_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.meal_entries me
    where me.id = new.meal_entry_id
      and me.family_id = new.family_id
      and me.is_planned = true
  ) then
    raise exception 'Le repas ne correspond pas au foyer ou n’est pas planifié.';
  end if;

  if not exists (
    select 1
    from public.family_members fm
    where fm.family_id = new.family_id
      and fm.user_id = new.user_id
  ) then
    raise exception 'La personne doit appartenir au foyer.';
  end if;

  if new.is_present then
    raise exception 'Une ligne de présence ne doit être créée que pour une absence.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_meal_attendance_membership_trigger
  on public.meal_attendance;
create trigger validate_meal_attendance_membership_trigger
  before insert or update on public.meal_attendance
  for each row execute function public.validate_meal_attendance_membership();

alter table public.meal_attendance enable row level security;
drop policy if exists meal_attendance_all_family_members
  on public.meal_attendance;
create policy meal_attendance_all_family_members
  on public.meal_attendance
  for all to authenticated
  using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

grant select, insert, update, delete
  on public.meal_attendance to authenticated;

-- Realtime est activé si la publication existe ; le polling applicatif
-- reste disponible en secours si cette publication n'est pas activée.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'meal_attendance'
     ) then
    execute 'alter publication supabase_realtime add table public.meal_attendance';
  end if;
end
$$;

commit;

-- Vérification de la structure après exécution.
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('meal_entries', 'meal_attendance')
order by table_name, ordinal_position;
