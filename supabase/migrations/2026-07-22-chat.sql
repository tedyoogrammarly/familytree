-- =============================================================
-- Family Archive — Chat (admin-only, Slack-style channels)  [v4.74]
-- =============================================================
-- A realtime chat surface: sections group channels in the sidebar, channels
-- hold messages, messages carry emoji reactions and file/image attachments,
-- and edited messages are flagged (edited_at). Chat is ADMIN-ONLY: every
-- policy gates on public.is_admin(), so no non-admin account can read or write
-- any chat table (unlike Memories, which is open to all authenticated users).
--
-- Mirrors the memories/albums table+RLS conventions (author default auth.uid(),
-- reactions one row per (message,user,emoji)). Attachments stay as JSONB on the
-- message row and reference private storage objects as [{bucket,path,...}].
--
-- ⚠️  Ship together with the app change. Run on a clone first. Requires the
--     existing public.is_admin() function (supabase/schema.sql).
-- =============================================================

-- ---- Sections: named + emoji grouping in the sidebar (shared, admin-managed)
create table if not exists public.chat_sections (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  emoji       text not null default '💬',
  sort_order  int  not null default 0,
  created_by  uuid references auth.users(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

-- ---- Channels. section_id null = "ungrouped" (rendered above sections).
create table if not exists public.chat_channels (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                          -- stored WITHOUT leading '#'
  section_id  uuid references public.chat_sections(id) on delete set null,
  is_default  boolean not null default false,         -- #all-chat = true, undeletable in UI
  sort_order  int not null default 0,
  created_by  uuid references auth.users(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

-- ---- Messages. edited_at null => never edited; set => show "(edited)".
create table if not exists public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references public.chat_channels(id) on delete cascade,
  author      uuid not null references auth.users(id) on delete set null default auth.uid(),
  body        text,
  attachments jsonb not null default '[]'::jsonb,     -- [{bucket,path,name,contentType,sizeBytes,isImage}]
  edited_at   timestamptz,
  created_at  timestamptz not null default now()
);

-- ---- Reactions (same shape as memory_reactions).
create table if not exists public.chat_message_reactions (
  message_id  uuid not null references public.chat_messages(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  emoji       text not null,
  created_at  timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create index if not exists chat_channels_section_idx  on public.chat_channels(section_id);
create index if not exists chat_messages_channel_idx   on public.chat_messages(channel_id, created_at);
create index if not exists chat_reactions_message_idx  on public.chat_message_reactions(message_id);

-- ---- RLS: admin-only end to end. -----------------------------------------
alter table public.chat_sections          enable row level security;
alter table public.chat_channels          enable row level security;
alter table public.chat_messages          enable row level security;
alter table public.chat_message_reactions enable row level security;

-- Sections
drop policy if exists "chat_sections all" on public.chat_sections;
create policy "chat_sections all" on public.chat_sections
  for all using (public.is_admin()) with check (public.is_admin());

-- Channels
drop policy if exists "chat_channels all" on public.chat_channels;
create policy "chat_channels all" on public.chat_channels
  for all using (public.is_admin()) with check (public.is_admin());

-- Messages: read/insert require admin; insert also pins author to self.
-- Update requires admin AND author=self (edit own only). Delete: any admin.
drop policy if exists "chat_messages read"   on public.chat_messages;
drop policy if exists "chat_messages insert" on public.chat_messages;
drop policy if exists "chat_messages update" on public.chat_messages;
drop policy if exists "chat_messages delete" on public.chat_messages;
create policy "chat_messages read"   on public.chat_messages for select using (public.is_admin());
create policy "chat_messages insert" on public.chat_messages for insert with check (public.is_admin() and author = auth.uid());
create policy "chat_messages update" on public.chat_messages for update using (public.is_admin() and author = auth.uid()) with check (public.is_admin() and author = auth.uid());
create policy "chat_messages delete" on public.chat_messages for delete using (public.is_admin());

-- Reactions: admin read; insert pins user to self; delete own reaction.
drop policy if exists "chat_reactions read"   on public.chat_message_reactions;
drop policy if exists "chat_reactions insert" on public.chat_message_reactions;
drop policy if exists "chat_reactions delete" on public.chat_message_reactions;
create policy "chat_reactions read"   on public.chat_message_reactions for select using (public.is_admin());
create policy "chat_reactions insert" on public.chat_message_reactions for insert with check (public.is_admin() and user_id = auth.uid());
create policy "chat_reactions delete" on public.chat_message_reactions for delete using (public.is_admin() and user_id = auth.uid());

-- ---- Realtime: broadcast row changes to subscribed clients. --------------
-- (Mirrors schema.sql:146 `alter publication supabase_realtime add table public.archive`.)
-- Wrapped so re-running the migration doesn't error if already added.
do $$
begin
  begin alter publication supabase_realtime add table public.chat_messages;          exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.chat_message_reactions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.chat_channels;          exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.chat_sections;          exception when duplicate_object then null; end;
end $$;

-- ---- Seed the default #all-chat channel (idempotent). --------------------
insert into public.chat_channels (name, is_default, sort_order)
select 'all-chat', true, 0
where not exists (select 1 from public.chat_channels where is_default = true);

-- =============================================================
-- ROLLBACK
--   alter publication supabase_realtime drop table public.chat_message_reactions;
--   alter publication supabase_realtime drop table public.chat_messages;
--   alter publication supabase_realtime drop table public.chat_channels;
--   alter publication supabase_realtime drop table public.chat_sections;
--   drop table if exists public.chat_message_reactions;
--   drop table if exists public.chat_messages;
--   drop table if exists public.chat_channels;
--   drop table if exists public.chat_sections;
-- =============================================================
