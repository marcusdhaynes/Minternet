-- Add end-to-end encrypted identity records to Minternet Realtime sync.
-- This changes only the Minternet-owned record-kind constraint.
begin;
alter table if exists public.minternet_sync_state
  drop constraint if exists minternet_sync_state_kind_check;
alter table if exists public.minternet_sync_state
  add constraint minternet_sync_state_kind_check check (
    kind in ('tab','group','bookmark','login','payment','identity','undo','prefs')
  );
commit;
