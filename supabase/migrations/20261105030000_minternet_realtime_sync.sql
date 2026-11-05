-- Minternet push-only encrypted cross-platform state.
-- Deploy ONLY into a separate Minternet project, never Somniel/ProSeU.
-- Google provider must be configured in Supabase Auth before use.
begin;

create table if not exists public.minternet_sync_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in
    ('tab','group','bookmark','login','payment','undo','prefs')),
  item_key text not null check (length(item_key) between 1 and 180),
  ciphertext text,
  deleted boolean not null default false,
  revision bigint not null default 0,
  server_at timestamptz not null default clock_timestamp(),
  primary key (user_id,kind,item_key),
  constraint minternet_cipher_size check
    (ciphertext is null or length(ciphertext) <= 262144),
  constraint minternet_active_encrypted check
    (deleted or (ciphertext is not null and
       left(ciphertext,5) = 'enc1:'))
);
create index if not exists minternet_state_owner_revision
  on public.minternet_sync_state(user_id,revision);

create table if not exists public.minternet_sync_journal (
  sequence bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  item_key text not null,
  previous_ciphertext text,
  previous_deleted boolean not null,
  ciphertext text,
  deleted boolean not null,
  server_at timestamptz not null,
  revision bigint not null,
  device_id text not null default '',
  undo_of bigint,
  constraint minternet_journal_cipher_size check
    (ciphertext is null or length(ciphertext) <= 262144)
);
create index if not exists minternet_journal_user_latest
  on public.minternet_sync_journal(user_id,sequence desc);

create sequence if not exists public.minternet_sync_revision_seq;

alter table public.minternet_sync_state enable row level security;
alter table public.minternet_sync_journal enable row level security;

drop policy if exists minternet_sync_own_read on public.minternet_sync_state;
create policy minternet_sync_own_read
  on public.minternet_sync_state for select to authenticated
  using (user_id=(select auth.uid()));
drop policy if exists minternet_sync_own_insert on public.minternet_sync_state;
create policy minternet_sync_own_insert
  on public.minternet_sync_state for insert to authenticated
  with check (user_id=(select auth.uid()));
drop policy if exists minternet_sync_own_update on public.minternet_sync_state;
create policy minternet_sync_own_update
  on public.minternet_sync_state for update to authenticated
  using (user_id=(select auth.uid()))
  with check (user_id=(select auth.uid()));
drop policy if exists minternet_sync_own_delete on public.minternet_sync_state;
-- Physical deletion is intentionally unavailable: tombstones sync across
-- all devices and prevent removed tabs/logins from reappearing.
drop policy if exists minternet_journal_own_read on public.minternet_sync_journal;
create policy minternet_journal_own_read
  on public.minternet_sync_journal for select to authenticated
  using (user_id=(select auth.uid()));

revoke all on public.minternet_sync_state from anon;
revoke all on public.minternet_sync_journal from anon;
revoke all on public.minternet_sync_journal from authenticated;
grant select,insert,update on public.minternet_sync_state to authenticated;
grant select on public.minternet_sync_journal to authenticated;
grant usage, select on sequence public.minternet_sync_revision_seq to authenticated;

-- A server-side total order, not an untrusted device clock, determines who
-- wins within the same second. No client can supply server_at or revision.
create or replace function public.minternet_stamp_sync()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null or new.user_id <> (select auth.uid()) then
    raise exception 'Minternet sync requires owner authentication';
  end if;
  new.revision := nextval('public.minternet_sync_revision_seq'::regclass);
  new.server_at := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists minternet_stamp_sync_trigger
  on public.minternet_sync_state;
create trigger minternet_stamp_sync_trigger
  before insert or update on public.minternet_sync_state
  for each row execute function public.minternet_stamp_sync();

-- This trigger is NOT directly callable over the Data API. Its privileged
-- context is only used for journaling and a private Realtime broadcast.
create or replace function public.minternet_sync_after_write()
returns trigger language plpgsql security definer
set search_path = '' as $$
declare
  change_id bigint;
begin
  insert into public.minternet_sync_journal(
    user_id,kind,item_key,previous_ciphertext,previous_deleted,
    ciphertext,deleted,server_at,revision)
  values (
    new.user_id,new.kind,new.item_key,
    case when tg_op='INSERT' then null else old.ciphertext end,
    case when tg_op='INSERT' then true else old.deleted end,
    new.ciphertext,new.deleted,new.server_at,new.revision
  ) returning sequence into change_id;

  perform realtime.send(
    jsonb_build_object('kind',new.kind,'item_key',new.item_key,
      'revision',new.revision,'sequence',change_id,
      'deleted',new.deleted),
    'sync',
    'minternet:'||new.user_id::text,
    true
  );
  return null;
end;
$$;
revoke all on function public.minternet_sync_after_write() from public;
drop trigger if exists minternet_sync_after_write_trigger
  on public.minternet_sync_state;
create trigger minternet_sync_after_write_trigger
  after insert or update on public.minternet_sync_state
  for each row execute function public.minternet_sync_after_write();

-- An Undo is another authoritative write, so it is broadcast on the same
-- private channel and can itself be undone. The previous value is retained
-- for all record types, including encrypted passwords and payment cards.
create or replace function public.minternet_undo_last()
returns jsonb language plpgsql security invoker
set search_path = '' as $$
declare
  last_change public.minternet_sync_journal%rowtype;
  current_row public.minternet_sync_state%rowtype;
  latest public.minternet_sync_state%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in to use synced Undo';
  end if;

  -- Serializes undo against other undo requests in the same user account.
  perform pg_advisory_xact_lock(hashtext((select auth.uid())::text), 91821);

  select * into last_change
  from public.minternet_sync_journal
  where user_id=(select auth.uid())
  order by sequence desc limit 1;
  if not found then return jsonb_build_object('ok',false,'reason','empty');end if;

  select * into current_row from public.minternet_sync_state
  where user_id=(select auth.uid()) and kind=last_change.kind
     and item_key=last_change.item_key for update;
  if not found or current_row.revision<>last_change.revision then
    return jsonb_build_object('ok',false,'reason','newer-change');
  end if;

  update public.minternet_sync_state
  set ciphertext=last_change.previous_ciphertext,
      deleted=last_change.previous_deleted
  where user_id=(select auth.uid()) and
      kind=last_change.kind and item_key=last_change.item_key
  returning * into latest;
  return jsonb_build_object('ok',true,'kind',latest.kind,
    'item_key',latest.item_key,'revision',latest.revision,
    'server_at',latest.server_at,'undid_sequence',last_change.sequence);
end;
$$;
revoke all on function public.minternet_undo_last() from public,anon;
grant execute on function public.minternet_undo_last() to authenticated;

-- A Realtime subscriber can join ONLY its own account's private topic.
drop policy if exists minternet_realtime_member on realtime.messages;
create policy minternet_realtime_member
  on realtime.messages for select to authenticated
  using (realtime.topic() = 'minternet:'||(select auth.uid())::text);

commit;
