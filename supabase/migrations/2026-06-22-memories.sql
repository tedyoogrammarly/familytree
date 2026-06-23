-- =============================================================
-- Family Archive — Memories moved to dedicated tables (open feed)
-- =============================================================
-- Everyone signed in can post/react/comment; authors (or admin) edit/delete
-- their own. Reactions are one row per (memory,user,emoji) so concurrent
-- taps never clobber. Photos/tags stay as JSONB on the memory row (per-post,
-- not concurrently edited). Existing posts are migrated by a separate,
-- non-destructive backfill (see migrations/README + plan Task 15).
--
-- ⚠️  Ship together with the app change (plan Task 14). Test on a clone first.
-- =============================================================

create table if not exists public.memories (
  id          uuid primary key default gen_random_uuid(),
  author      uuid not null references auth.users(id) on delete set null default auth.uid(),
  date        date not null,
  body        text,
  tags        jsonb not null default '[]'::jsonb,
  photos      jsonb not null default '[]'::jsonb,   -- [{bucket,path}]
  created_at  timestamptz not null default now()
);

create table if not exists public.memory_reactions (
  memory_id   uuid not null references public.memories(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  emoji       text not null,
  created_at  timestamptz not null default now(),
  primary key (memory_id, user_id, emoji)
);

create table if not exists public.memory_comments (
  id          uuid primary key default gen_random_uuid(),
  memory_id   uuid not null references public.memories(id) on delete cascade,
  author      uuid not null references auth.users(id) on delete set null default auth.uid(),
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists memory_reactions_mem_idx on public.memory_reactions(memory_id);
create index if not exists memory_comments_mem_idx   on public.memory_comments(memory_id);

alter table public.memories         enable row level security;
alter table public.memory_reactions enable row level security;
alter table public.memory_comments  enable row level security;

drop policy if exists "memories read"   on public.memories;
drop policy if exists "memories insert" on public.memories;
drop policy if exists "memories update" on public.memories;
drop policy if exists "memories delete" on public.memories;
create policy "memories read"   on public.memories for select using (auth.role() = 'authenticated');
create policy "memories insert" on public.memories for insert with check (author = auth.uid());
create policy "memories update" on public.memories for update using (author = auth.uid() or public.is_admin()) with check (author = auth.uid() or public.is_admin());
create policy "memories delete" on public.memories for delete using (author = auth.uid() or public.is_admin());

drop policy if exists "memory_reactions read"   on public.memory_reactions;
drop policy if exists "memory_reactions insert" on public.memory_reactions;
drop policy if exists "memory_reactions delete" on public.memory_reactions;
create policy "memory_reactions read"   on public.memory_reactions for select using (auth.role() = 'authenticated');
create policy "memory_reactions insert" on public.memory_reactions for insert with check (user_id = auth.uid());
create policy "memory_reactions delete" on public.memory_reactions for delete using (user_id = auth.uid());

drop policy if exists "memory_comments read"   on public.memory_comments;
drop policy if exists "memory_comments insert" on public.memory_comments;
drop policy if exists "memory_comments delete" on public.memory_comments;
create policy "memory_comments read"   on public.memory_comments for select using (auth.role() = 'authenticated');
create policy "memory_comments insert" on public.memory_comments for insert with check (author = auth.uid());
create policy "memory_comments delete" on public.memory_comments for delete using (author = auth.uid() or public.is_admin());

-- =============================================================
-- ROLLBACK
--   drop table if exists public.memory_comments;
--   drop table if exists public.memory_reactions;
--   drop table if exists public.memories;
-- =============================================================
