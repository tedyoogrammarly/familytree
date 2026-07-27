-- =============================================================
-- Family Archive — Chat threads (v4.76)
-- =============================================================
-- Adds Slack-style threads to chat_messages via a self-referential parent_id.
--   parent_id NULL  => a root message (shown in the channel timeline)
--   parent_id SET   => a reply, shown only inside its parent's thread panel
-- Replies cascade-delete with their parent. RLS is inherited from the existing
-- chat_messages policies (admin-only; author pins on insert/update) — no policy
-- changes needed since we only add a column.
--
-- ⚠️  Ship together with the app change (v4.76). Idempotent; safe to re-run.
--     Requires the base Chat migration (2026-07-22-chat.sql).
-- =============================================================

alter table public.chat_messages
  add column if not exists parent_id uuid
  references public.chat_messages(id) on delete cascade;

-- Fast lookup of a thread's replies, oldest-first.
create index if not exists chat_messages_parent_idx
  on public.chat_messages(parent_id, created_at);

-- =============================================================
-- ROLLBACK
--   drop index if exists chat_messages_parent_idx;
--   alter table public.chat_messages drop column if exists parent_id;
-- =============================================================
