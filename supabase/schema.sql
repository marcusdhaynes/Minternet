-- Optional encrypted sync schema ONLY. Client-side E2EE is not yet implemented.
-- Ciphertext only: never store browsing history plaintext or encryption keys.

create table if not exists public.minternet_sync_blobs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 category text not null check (category in ('settings','bookmarks')),
 ciphertext_b64 text not null,
 nonce_b64 text not null,
 revision bigint not null default 1 check (revision > 0),
 updated_at timestamptz not null default now(),
 unique(user_id, category)
);
create index if not exists minternet_sync_blobs_user_idx
 on public.minternet_sync_blobs (user_id);
alter table public.minternet_sync_blobs enable row level security;
revoke all on public.minternet_sync_blobs from anon;
grant select, insert, update, delete on public.minternet_sync_blobs to authenticated;
create policy "read own ciphertext" on public.minternet_sync_blobs
 for select to authenticated using (user_id = (select auth.uid()));
create policy "insert own ciphertext" on public.minternet_sync_blobs
 for insert to authenticated with check (user_id = (select auth.uid()));
create policy "update own ciphertext" on public.minternet_sync_blobs
 for update to authenticated using (user_id = (select auth.uid()))
 with check (user_id = (select auth.uid()));
create policy "delete own ciphertext" on public.minternet_sync_blobs
 for delete to authenticated using (user_id = (select auth.uid()));
