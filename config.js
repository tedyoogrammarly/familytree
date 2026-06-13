// Public Supabase config. Externalized from an inline <script> (v4.56) so the
// page can run under a Content-Security-Policy whose script-src does NOT allow
// 'unsafe-inline' — which is what actually blocks injected inline event handlers
// (onerror=, onclick=) and inline <script> payloads.
//
// The anon key is safe to ship publicly — all access is gated by Supabase RLS
// on the archive + member_accounts tables (see supabase/schema.sql). This file
// must load before app.js and may load after the Supabase UMD bundle.
window.SUPABASE_URL = 'https://inwutpebjqaakinybhwu.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlud3V0cGVianFhYWtpbnliaHd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0ODA3NDgsImV4cCI6MjA5NDA1Njc0OH0.JvzkwmacCDIYQz0CndXVM29OlR0HPZ8E1gCQ41E2Dj0';
