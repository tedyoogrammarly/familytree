-- =============================================================
-- Family Archive — Chat notifications, mentions & read state (v4.77)
-- =============================================================
-- Adds:
--   1. chat_messages.mentions  — jsonb array of mentioned auth user ids
--      (set by the client when a message contains @Name tokens).
--   2. chat_reads              — per-user last-read timestamp per channel.
--      Unread  = messages in a channel newer than my last_read_at.
--      Mentions= those unread messages whose `mentions` contains my id.
--   3. member_accounts.chat_prefs — jsonb bag of this user's chat notification
--      settings (mute all / mute mentions / chosen sounds).
--
-- All chat_* access stays admin-only. chat_reads is per-user: a user may only
-- read/write their own rows.
--
-- ⚠️  Ship together with the app change (v4.77). Idempotent; safe to re-run.
--     Requires 2026-07-22-chat.sql (base) and is independent of threads.
-- =============================================================

-- 1. mentions on messages
alter table public.chat_messages
  add column if not exists mentions jsonb not null default '[]'::jsonb;

-- 2. per-user read state
create table if not exists public.chat_reads (
  user_id       uuid not null references auth.users(id) on delete cascade default auth.uid(),
  channel_id    uuid not null references public.chat_channels(id) on delete cascade,
  last_read_at  timestamptz not null default now(),
  primary key (user_id, channel_id)
);

alter table public.chat_reads enable row level security;
drop policy if exists "chat_reads own" on public.chat_reads;
-- Own rows only; still admin-gated to match the rest of Chat.
create policy "chat_reads own" on public.chat_reads
  for all using (public.is_admin() and user_id = auth.uid())
  with check (public.is_admin() and user_id = auth.uid());

do $$ begin
  alter publication supabase_realtime add table public.chat_reads;
exception when duplicate_object then null; end $$;

-- 3. per-user chat preferences (mute toggles + sound choices)
alter table public.member_accounts
  add column if not exists chat_prefs jsonb not null default '{}'::jsonb;

-- =============================================================
-- ROLLBACK
--   alter table public.member_accounts drop column if exists chat_prefs;
--   alter publication supabase_realtime drop table public.chat_reads;
--   drop table if exists public.chat_reads;
--   alter table public.chat_messages drop column if exists mentions;
-- =============================================================
