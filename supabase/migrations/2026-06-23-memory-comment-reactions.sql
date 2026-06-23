-- =============================================================
-- Family Archive — emoji reactions on Memory comments
-- =============================================================
-- Mirrors public.memory_reactions, but for individual comments. One row per
-- (comment, user, emoji) so simultaneous reactions never clobber. Anyone
-- signed in can react; you can only add/remove your OWN reaction.
--
-- ⚠️  Ship together with the app change (v4.65). The front-end degrades
--     gracefully if this table is absent (comment reactions just won't save).
-- =============================================================

create table if not exists public.memory_comment_reactions (
  comment_id  uuid not null references public.memory_comments(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  emoji       text not null,
  created_at  timestamptz not null default now(),
  primary key (comment_id, user_id, emoji)
);

create index if not exists memory_comment_reactions_comment_idx
  on public.memory_comment_reactions(comment_id);

alter table public.memory_comment_reactions enable row level security;

drop policy if exists "mcr read"   on public.memory_comment_reactions;
drop policy if exists "mcr insert" on public.memory_comment_reactions;
drop policy if exists "mcr delete" on public.memory_comment_reactions;
create policy "mcr read"   on public.memory_comment_reactions for select using (auth.role() = 'authenticated');
create policy "mcr insert" on public.memory_comment_reactions for insert with check (user_id = auth.uid());
create policy "mcr delete" on public.memory_comment_reactions for delete using (user_id = auth.uid());

-- =============================================================
-- ROLLBACK
--   drop table if exists public.memory_comment_reactions;
-- =============================================================
