// Supabase project: ai_agent (ap-northeast-2)
// This uses the publishable ("anon") key, which is safe to expose in
// client-side code — access is controlled by Row Level Security on the
// database side, not by keeping this key secret.
const SUPABASE_URL = 'https://rxohwqbxnehnqbjfuhgr.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_exJWio9jlBXFaXMHW6Eyow_Nqetd9_Q';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
