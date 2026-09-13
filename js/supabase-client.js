/* Drip Closet — shared Supabase client
 * Public browser key only. RLS is the authorization boundary.
 */
(function () {
  const SUPABASE_URL = 'https://cezhlycsuecrvwfxbrpg.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_6P8oGvY4B4-dFopVbUGAtQ_sJ59WLwH';

  function loadClient() {
    if (window.supabase && window.supabase.createClient) {
      window.DripClosetSupabase = window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storageKey: 'drip-closet-auth'
          }
        }
      );
      window.DRIP_CLOSET_SUPABASE_URL = SUPABASE_URL;
      return window.DripClosetSupabase;
    }
    console.error('Drip Closet: Supabase JS client was not loaded.');
    return null;
  }

  window.getDripClosetSupabase = loadClient;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadClient, { once: true });
  } else {
    loadClient();
  }
})();
