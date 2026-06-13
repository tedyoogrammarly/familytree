# The Family Archive — Refresh + Harden

**Date:** 2026-06-13
**Status:** Design — awaiting approval
**Scope decision:** Refresh + Harden · Light theme only · Code-only hardening now (DB/RLS deferred to documented SQL follow-up)

---

## Goal

The app is well-built but has "drifted into two products": the original forest-green / copper / Fraunces identity is intact on older pages, while everything after ~v4.40 (Recipes, Memories, My Kids, Stories, Documents) is hardcoded indigo. Re-unify the design language, add the depth/typography/data-surface craft that's missing, and fix the live-app correctness/security landmines — **without** a rewrite and **without** structural data-model changes.

Source of findings: 13-agent audit, 2026-06-13 (`temporary screenshots/` + full code read of `index.html`, `styles.css`, `app.js`, `supabase/`).

## Non-goals (explicitly deferred)

- Dark mode (chosen: light only for now).
- Supabase schema/RLS row-split for the Vault — delivered as a **separate documented SQL migration** the owner runs, not applied by me.
- Photo migration off base64-in-JSONB; high-churn realtime row-splitting; tree event-delegation rewrite; esbuild build step; large code-quality refactors. (These were the "Re-architect" package, not selected.)

---

## Part A — Visual refresh: "Pressed-paper archive, lit warmer"

Keep forest-green + warm-paper + Fraunces/Inter **exactly**. Elevate craft via mostly token-level edits (low risk, no markup change). Implemented in `styles.css`; a few `index.html` label/markup touch-ups.

### A1. Re-unify color on green + copper (highest impact)
- Add tokens to `:root`: `--tint-50/100/200` (forest-derived), `--brand-600`, `--hairline`, `--ring-brand`.
- Global replace `rgba(99,102,241,X)` → forest equivalents (`rgba(47,107,89,X)` for fills/borders, `var(--brand-700)` for text). 26 sites.
- Replace every `var(--brand-900,#0044cc)` → `var(--brand-900,#173028)` so the blue fallback can never surface. 7 sites.
- Consolidate ad-hoc pills/tags/chips (memory-tag, recipe-card-cat, role/type pills, document-cat, newsletter-tag) into one `.pill` base with brand-tint + copper-tint custom props.

### A2. Elevation, depth, tactility (one-edit, app-wide)
- Re-tint the 3 shadow tokens (`styles.css:38-49`) with a trace of forest-green in the ambient layer.
- Add inset `0 1px 0 rgba(255,255,255,.6)` pressed-paper top-highlight on `.panel` / `.node` / `.vault-card`.
- 3-tier surface system: page (paper) → raised (cards) → floating (drawer/modal/popover).
- Reuse the existing `auth-bg-grain` SVG noise on topbar/hero/drawer-hero via a shared `.has-grain::after`.

### A3. Editorial typography
- `font-optical-sizing: auto` on body (Fraunces opsz axis already downloaded, currently unused).
- `.page-head h2` → `clamp(30px,4vw,44px)`, weight 400, `letter-spacing:-0.03em` — one display moment per page.
- Per-tier `--opsz` so small serif (node-name/modal-head) stays sturdy.
- Consolidate ~8 near-duplicate eyebrow declarations into one `.eyebrow` utility (.18em tracking + copper hairline).

### A4. Data surfaces (tables + calendar)
- `.table`: row hover (`--tint-50` + 3px copper inset-left), sticky tinted `thead`, zebra striping, rounded overflow-clipped `.table-wrap`.
- Calendar: weekend tint via `nth-child`, soft brand ring+fill on `is-today`, tinted elevated `cal-chip`s, cell radius gutter.
- Tokenize the focus ring (`--ring-brand`) and reuse for the ~15 hand-typed `rgba(47,107,89,.15)` instances.
- `.btn-primary`/`.btn-secondary` hover lift; new `.btn-tonal` green-tint medium-emphasis variant.

### A5. Accessibility quick wins (bundled with visuals)
- Global `@media (prefers-reduced-motion: reduce)` guard (currently 0 occurrences).
- Global `:focus-visible` fallback ring (nav-tab, icon-btn, seg-btn, tabs, pills lack them).

## Part B — Correctness hardening (code-only)

| # | Fix | Location |
|---|-----|----------|
| B1 | `toast()` honors `kind` — add `is-warn`/`is-error` classes + CSS so the 57 failure call sites are visibly distinct from success | `app.js:9151` + `styles.css` |
| B2 | Guard `new Date(c.sealedAt).toISOString()` with a safe `isoDay()` helper — one bad record currently blanks the whole list | `app.js:16128`, `app.js:17196` |
| B3 | Media-upload counter: single `finally` decrement + reset `this.uploading=false` on modal close (fixes double-decrement + permanent wedge) | `app.js:16963-17023`, `15858+`, `16294+`, `16926+`, `17341+` |
| B4 | Event attendees keyed by stable `id`, not array index | `app.js:6188-6264`, `app.js:6647` |
| B5 | Clear `DashboardView.clockTimer` on view-leave; null-guard `renderClock` | `app.js:9616` |
| B6 | Surface `flushSaveArchive` save failures to the user (currently `console.warn` only) | `app.js:231` |

## Part C — Security hardening (code-only; DB deferred)

| # | Fix | Location |
|---|-----|----------|
| C1 | RichText sanitizer: replace `javascript:` blacklist with `https?\|mailto\|tel` **allowlist** after stripping control chars; apply on read() and render() | `app.js:14258` |
| C2 | `cssUrl()` helper that escapes + scheme-validates all `url('${...}')` / inline-style photo/color sinks (~20 raw sites) | `app.js:2763,6199,6465,10784,11387`, … |
| C3 | Drawer 529-plan `a.href` scheme allowlist (mirror the tree-card https normalization) | `app.js:3003` |
| C4 | Add a Content-Security-Policy meta (`script-src 'self'` + the two known CDNs) as defense-in-depth | `index.html` head |

### Deferred DB follow-up (written, not applied)
`supabase/migrations/` SQL + a README: split Vault / time-capsule bodies / financials into rows with admin-only / owner-only / time-gated RLS SELECT, since the current single world-readable JSONB row makes the client gates cosmetic. Delivered as documentation for the owner to run and test.

## Part D — Tiny UX correctness
- Rename the vault nav tab from "Admin" → "Vault" (it contradicts the "Members" tab, which is the actual admin view).
- Remove or properly gate the dead hidden Time Capsule / Stories nav tabs.

---

## Verification approach

The app gates almost every view behind Supabase login (no local creds available to me). To verify visual changes without authenticated access:

1. Build a throwaway **`preview.html` style gallery** that imports the real `styles.css` and renders representative markup for every refreshed component (buttons, pills, cards, nodes, tables, calendar cells, modals, drawer, panels) with sample data, in both "before/after" context.
2. Serve via `node serve.mjs` (localhost:3000) and screenshot the gallery with the local Puppeteer in `node_modules`; iterate ≥2 comparison rounds per the project's screenshot discipline.
3. Verify the **login screen** directly (the one unauthenticated view) against before/after.
4. Code-review the hardening fixes against the cited line numbers; reason about token-level CSS for authenticated views; hand authenticated-view spot-checks to the owner.

The `preview.html` gallery doubles as a living style reference and is left in the repo.

## Rollout & risk

- Work on a feature branch; commit atomically per theme.
- CSS-token changes are reversible and low-risk; correctness/security fixes are small and targeted.
- No changes to data shape, Supabase schema, or auth flow in this pass.
- Owner does a manual smoke test of authenticated views before merge.

## Execution order (impact-to-risk)

1. **Quick wins** (Part A1 indigo purge, A2 shadows, A3 opsz/masthead, A4 table+calendar, A5 a11y guards) + **B1 toast** + **D** labels — all low-risk, high-visibility.
2. **Hardening** B2–B6, C1–C4 — small, targeted.
3. **DB follow-up** SQL + README — written, handed off.
4. `preview.html` gallery built first as the verification harness.
