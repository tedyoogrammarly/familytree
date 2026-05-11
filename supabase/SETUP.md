# Supabase setup — Family Archive

A short, one-time setup so the app reads/writes from a real database instead of browser localStorage. ~5 minutes.

## 1. Create the project

1. Go to **https://supabase.com** → Sign up / log in.
2. **New project** → name it `family-archive` (or anything).
3. Pick a region close to you. Set a strong database password and save it somewhere — you won't need it for the app, but Supabase asks for it.
4. Wait ~1 min for provisioning.

## 2. Run the schema

1. In the Supabase dashboard, open **SQL Editor** (left sidebar).
2. Open `supabase/schema.sql` from this repo, copy the whole file.
3. Paste into the SQL Editor → click **Run**.
4. You should see "Success. No rows returned." That created:
   - `archive` — single-row JSON store for the whole app state
   - `member_accounts` — maps Supabase Auth users to in-app member ids
   - RLS policies (auth required to read, admin required to write)
   - `claim_first_admin()` — promotes the first sign-up to admin

## 3. Enable email auth

1. Left sidebar → **Authentication** → **Providers**.
2. **Email** is enabled by default. Leave it on.
3. *(Recommended)* Toggle **Confirm email** to **off** for now so you don't have to verify every test account. Re-enable later for production.

## 4. Lock down sign-ups (optional but recommended)

The family archive isn't meant to be public. After your family members have signed up:

1. **Authentication** → **Sign-ups** → toggle **Allow new users to sign up** **off**.
2. Going forward, you invite new family members from **Authentication** → **Users** → **Add user**.

## 5. Copy your API credentials

1. Left sidebar → **Project Settings** → **API**.
2. Copy two values:
   - **Project URL** — looks like `https://xyzabc.supabase.co`
   - **anon public key** — long JWT string starting with `eyJ...` (the anon/public one, NOT the service_role secret)

Paste both into the next message so I can wire the app up. The anon key is safe to commit to a public repo — it's protected by the RLS policies above.

## 6. Deploy the admin password-reset Edge Function

The browser cannot set another user's password (that needs the `service_role` key, which must never ship to clients). The app calls a small Edge Function instead. Deploy it once:

1. Left sidebar → **Edge Functions** → **Deploy a new function**.
2. Name it exactly `admin-reset-password`.
3. Paste the contents of `supabase/functions/admin-reset-password/index.ts` from this repo.
4. Click **Deploy**. No env-var setup needed — Supabase auto-injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.

The "Reset PW" button in Admin will start working as soon as this is deployed.

## 7. First-time login (after the code is wired up)

1. Open the app.
2. Sign up with your email + password — that account becomes the admin automatically (via `claim_first_admin()`).
3. Add family members from the Admin page. Provide an email on the create form and the Supabase Auth user is created automatically; the generated password is shown once for you to share.
4. Click **Reset PW** on any member to generate a new password (calls the Edge Function above).
