/* Drip Closet — Supabase Auth helpers */
(function () {
  async function db() {
    const client = await window.getDripClosetSupabase();
    if (!client) throw new Error('Supabase client unavailable');
    return client;
  }

  window.DripClosetAuth = {
    async signIn(email, password) {
      const client = await db();
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data;
    },

    async signUp(email, password, profile = {}) {
      const client = await db();
      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectTo, data: profile }
      });
      if (error) throw error;
      return data;
    },

    async signOut() {
      const client = await db();
      const { error } = await client.auth.signOut();
      if (error) throw error;
    },

    async session() {
      const client = await db();
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session;
    },

    async user() {
      const client = await db();
      const { data, error } = await client.auth.getUser();
      if (error) throw error;
      return data.user;
    },

    async profile() {
      const client = await db();
      const user = await this.user();
      if (!user) return null;
      const { data, error } = await client.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (error) throw error;
      return data;
    },

    async isAdmin() {
      const profile = await this.profile();
      return !!profile && profile.role === 'admin';
    },

    onAuthStateChange(callback) {
      return window.getDripClosetSupabase().then(client => client.auth.onAuthStateChange(callback));
    }
  };
})();
