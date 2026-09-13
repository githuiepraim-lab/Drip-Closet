/* Drip Closet — authoritative product API
 * Use this module instead of localStorage for products/inventory/images.
 */
(function () {
  async function db() {
    const client = await window.getDripClosetSupabase();
    if (!client) throw new Error('Supabase client unavailable');
    return client;
  }

  function cleanProduct(row) {
    return {
      ...row,
      id: String(row.id),
      sizes: Array.isArray(row.sizes) ? row.sizes : [],
      images: Array.isArray(row.images) ? row.images : []
    };
  }

  window.DripClosetProducts = {
    async list({ includeInactive = false } = {}) {
      const client = await db();
      let query = client.from('products').select('*').order('created_at', { ascending: false });
      if (!includeInactive) query = query.eq('active', true);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(cleanProduct);
    },

    async get(id) {
      const client = await db();
      const { data, error } = await client.from('products').select('*').eq('id', String(id)).maybeSingle();
      if (error) throw error;
      return data ? cleanProduct(data) : null;
    },

    async create(product) {
      const client = await db();
      const payload = { ...product };
      delete payload.id;
      const { data, error } = await client.from('products').insert(payload).select('*').single();
      if (error) throw error;
      return cleanProduct(data);
    },

    async update(id, changes) {
      const client = await db();
      const payload = { ...changes };
      delete payload.id;
      payload.updated_at = new Date().toISOString();
      const { data, error } = await client.from('products').update(payload).eq('id', String(id)).select('*').single();
      if (error) throw error;
      return cleanProduct(data);
    },

    async remove(id) {
      const client = await db();
      const { error } = await client.from('products').delete().eq('id', String(id));
      if (error) throw error;
    },

    async uploadImage(file, productId) {
      const client = await db();
      if (!(file instanceof File)) throw new Error('A File is required');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Only JPEG, PNG or WebP images are allowed');
      if (file.size > 10 * 1024 * 1024) throw new Error('Image exceeds the 10 MB limit');
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
      const path = `products/${String(productId)}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await client.storage.from('product-images').upload(path, file, {
        contentType: file.type,
        upsert: false,
        cacheControl: '31536000'
      });
      if (uploadError) throw uploadError;
      const { data } = client.storage.from('product-images').getPublicUrl(path);
      return { path, url: data.publicUrl };
    }
  };
})();
