/* Drip Closet — shared Supabase client
 * Public browser key only. RLS is the authorization boundary.
 */
(function () {
  const SUPABASE_URL = 'https://cezhlycsuecrvwfxbrpg.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_6P8oGvY4B4-dFopVbUGAtQ_sJ59WLwH';
  const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

  async function loadClient() {
    if (window.DripClosetSupabase) return window.DripClosetSupabase;
    try {
      const mod = await import(CDN);
      const client = mod.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: 'drip-closet-auth'
        }
      });
      window.DripClosetSupabase = client;
      window.DRIP_CLOSET_SUPABASE_URL = SUPABASE_URL;
      return client;
    } catch (error) {
      console.error('Drip Closet: failed to load Supabase JS client', error);
      return null;
    }
  }

  window.getDripClosetSupabase = loadClient;
  loadClient();
})();
