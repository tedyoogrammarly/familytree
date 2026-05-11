// =============================================================
// admin-reset-password — Supabase Edge Function
// =============================================================
// Lets an authenticated admin set a new password for another user
// without ever shipping the service_role key to the browser.
//
// Flow:
//   1. Verify the caller's JWT (Supabase does this automatically).
//   2. Look up the caller in member_accounts and require is_admin.
//   3. Call auth.admin.updateUserById on the target with service_role.
//
// Deploy via the Supabase dashboard:
//   1. Edge Functions → "Deploy a new function" → name it
//      `admin-reset-password`.
//   2. Paste this file's contents.
//   3. Deploy. No env-var setup needed — Supabase auto-injects
//      SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

    // Caller-scoped client: respects RLS and resolves auth.uid() from the JWT.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401);

    const { data: account } = await userClient
      .from('member_accounts')
      .select('is_admin')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (!account?.is_admin) return json({ error: 'Admin only' }, 403);

    const body = await req.json().catch(() => ({}));
    const targetUserId = body?.target_user_id;
    const newPassword  = body?.new_password;
    if (!targetUserId || typeof targetUserId !== 'string') return json({ error: 'target_user_id is required' }, 400);
    if (!newPassword  || typeof newPassword  !== 'string' || newPassword.length < 6) return json({ error: 'new_password must be at least 6 characters' }, 400);

    // Privileged client. Service-role bypasses RLS and unlocks auth.admin.*.
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: updateErr } = await admin.auth.admin.updateUserById(targetUserId, {
      password: newPassword,
    });
    if (updateErr) return json({ error: updateErr.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message || 'Unknown error' }, 500);
  }
});
