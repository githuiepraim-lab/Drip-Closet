/* ═══════════════════════════════════════════════════════════════
 * DRIP CLOSET — admin / POS data layer (staff operations)
 * All permissions are enforced server-side (RLS + RPCs). This file
 * contains NO secrets and NO password hashes.
 * ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  async function db() {
    const client = await window.getDripClosetSupabase();
    if (!client) throw new Error('Could not reach Drip Closet servers. Check your connection.');
    return client;
  }

  /* ── session helpers ───────────────────────────────────────── */
  async function currentSession() {
    const client = await db();
    const { data: { session } } = await client.auth.getSession();
    return session || null;
  }
  async function currentProfile() {
    const client = await db();
    const { data: { user } } = await client.auth.getUser().catch(() => ({ data: { user: null } }));
    if (!user) return null;
    const { data } = await client.from('profiles').select('*').eq('id', user.id).maybeSingle();
    return data || null;
  }
  function isStaff(profile) {
    return !!profile && ['admin', 'manager', 'staff'].includes(profile.role) && (profile.account_status || 'active') === 'active';
  }
  function isAdmin(profile) { return !!profile && profile.role === 'admin' && (profile.account_status || 'active') === 'active'; }

  /* ── sign in: verifies server-side AND that the account has a staff role ── */
  async function signIn(email, password) {
    const client = await db();
    const { data, error } = await client.auth.signInWithPassword({ email: String(email).trim(), password: String(password) });
    if (error) {
      if (/Invalid login credentials/i.test(error.message)) throw new Error('Incorrect email or password.');
      if (/Email not confirmed/i.test(error.message)) throw new Error('Confirm your email before signing in.');
      throw new Error(error.message);
    }
    const prof = await currentProfile();
    if (!isStaff(prof)) {
      await client.auth.signOut();
      throw new Error('This account does not have staff access. Sign in with an admin/manager/staff account.');
    }
    return prof;
  }

  async function signOut() {
    try { const client = await db(); await client.auth.signOut(); } catch {}
  }

  /* ── products (staff see everything incl. unpublished) ─────── */
  function normalize(row) {
    const images = Array.isArray(row.images) ? row.images.filter(Boolean) : [];
    return Object.assign({}, row, {
      id: String(row.id),
      price: Number(row.price) || 0,
      sale_price: row.sale_price != null ? Number(row.sale_price) : null,
      stock: Number(row.stock) || 0,
      published: row.published != null ? !!row.published : row.active !== false,
      images,
      sizes: Array.isArray(row.sizes) ? row.sizes : [],
      colors: Array.isArray(row.colors) ? row.colors : []
    });
  }

  async function listProducts() {
    const client = await db();
    const { data, error } = await client.from('products').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(normalize);
  }

  async function upsertProduct(product) {
    const client = await db();
    const row = {
      name: product.name,
      description: product.description || '',
      category: product.category || 'New Arrival',
      gender: product.gender || 'unisex',
      shape: product.shape || null,
      price: Number(product.price) || 0,
      sale_price: product.sale_price != null && product.sale_price !== '' ? Number(product.sale_price) : null,
      sku: product.sku ? String(product.sku).trim() : null,
      stock: Math.max(0, parseInt(product.stock, 10) || 0),
      sizes: product.sizes || [],
      colors: product.colors || [],
      badge: product.badge || null,
      badge_text: product.badge_text || null,
      featured: !!product.featured,
      published: product.published !== false,
      active: product.published !== false,
      rating: product.rating != null ? Number(product.rating) : 5,
      background: product.background || null,
      accent: product.accent || null,
      images: product.images || [],
      updated_at: new Date().toISOString()
    };
    let query;
    if (product.id) {
      query = await client.from('products').update(row).eq('id', product.id);
    } else {
      query = await client.from('products').insert(Object.assign({ created_by: (await currentSession())?.user?.id || null }, row));
    }
    if (query.error) {
      if (/products_sku_key|duplicate key/i.test(query.error.message)) throw new Error('That SKU is already used by another product.');
      throw new Error(query.error.message);
    }
    const saved = (query.data || [])[0];
    return saved ? normalize(saved) : null;
  }

  async function deleteProduct(id) {
    const client = await db();
    const { error } = await client.from('products').delete().eq('id', id);
    if (error) throw error;
    return true;
  }

  async function setProductFlags(id, flags) {
    const client = await db();
    const row = Object.assign({}, flags, { updated_at: new Date().toISOString() });
    if (row.published != null) row.active = row.published;
    const { error } = await client.from('products').update(row).eq('id', id);
    if (error) throw error;
    return true;
  }

  /* ── variants ──────────────────────────────────────────────── */
  async function listVariants(productId) {
    const client = await db();
    const { data, error } = await client.from('product_variants').select('*').eq('product_id', productId).order('size');
    if (error) throw error;
    return data || [];
  }
  async function saveVariant(v) {
    const client = await db();
    const row = {
      product_id: v.product_id, size: v.size || null, color: v.color || null,
      sku: v.sku || null, stock: Math.max(0, parseInt(v.stock, 10) || 0),
      price: v.price != null && v.price !== '' ? Number(v.price) : null,
      updated_at: new Date().toISOString()
    };
    let res;
    if (v.id) res = await client.from('product_variants').update(row).eq('id', v.id);
    else res = await client.from('product_variants').upsert(row, { onConflict: 'product_id,size,color' });
    if (res.error) throw res.error;
    return true;
  }
  async function deleteVariant(id) {
    const client = await db();
    const { error } = await client.from('product_variants').delete().eq('id', id);
    if (error) throw error;
    return true;
  }

  /* ── image storage with compression ────────────────────────── */
  const BUCKET = window.DRIP_CLOSET_PRODUCT_BUCKET || 'product-images';
  const MAGIC_SIGNATURES = [
    { ext: 'jpg', test: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF, mime: 'image/jpeg' },
    { ext: 'png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47, mime: 'image/png' },
    { ext: 'webp', test: b => b.slice(0, 4).join() === '82,73,70,70' && b.slice(8, 12).join() === '87,69,66,80', mime: 'image/webp' },
    { ext: 'gif', test: b => b.slice(0, 3).join() === '71,73,70', mime: 'image/gif' }
  ];
  function sniffImage(file) {
    return file.arrayBuffer().then(buf => {
      const b = new Uint8Array(buf.slice(0, 16));
      const sig = MAGIC_SIGNATURES.find(s => s.test(b));
      if (!sig) throw new Error(`"${file.name}" is not a real image file (blocked for security).`);
      if (file.size > 15 * 1024 * 1024) throw new Error(`"${file.name}" is larger than 15 MB.`);
      return sig;
    });
  }
  function compressToJpeg(file, maxDim) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, (maxDim || 1600) / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(b => { URL.revokeObjectURL(url); b ? resolve(b) : reject(new Error('Compression failed.')); }, 'image/jpeg', 0.85);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image.')); };
      img.src = url;
    });
  }
  async function uploadProductImage(file) {
    const client = await db();
    const sig = await sniffImage(file);           // validate BEFORE any processing
    const blob = await compressToJpeg(file, 1600); // resize + compress → JPEG q0.85
    const rand = [...crypto.getRandomValues(new Uint8Array(8))].map(x => x.toString(16).padStart(2, '0')).join('');
    const safeName = String(file.name || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
    const path = `${Date.now()}_${rand}_${safeName.replace(/\.[^.]*$/, '')}.jpg`;
    const { error } = await client.storage.from(BUCKET)
      .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (error) {
      if (/already exists/i.test(error.message)) return uploadProductImage(file);
      throw new Error('Upload failed: ' + error.message);
    }
    const { data } = client.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }
  async function deleteStoredImage(publicUrl) {
    try {
      const client = await db();
      const marker = `/${BUCKET}/`;
      const i = String(publicUrl || '').indexOf(marker);
      if (i < 0) return;
      const path = decodeURIComponent(publicUrl.slice(i + marker.length));
      await client.storage.from(BUCKET).remove([path]);
    } catch {}
  }

  /* ── orders (staff view) ───────────────────────────────────── */
  async function listOrders(limit) {
    const client = await db();
    const { data, error } = await client.from('orders')
      .select('*, order_items(*)').order('created_at', { ascending: false }).limit(limit || 100);
    if (error) throw error;
    return data || [];
  }
  async function updateOrderStatus(orderId, status) {
    const client = await db();
    const { error } = await client.rpc('admin_update_order', { p_order_id: orderId, p_status: status });
    if (error) throw error;
    return true;
  }
  async function verifyPayment(paymentId, status, transactionId) {
    const client = await db();
    const { error } = await client.rpc('verify_payment', {
      p_payment_id: paymentId, p_status: status, p_transaction_id: transactionId || null
    });
    if (error) throw error;
    return true;
  }
  async function paymentsFor(orderIds) {
    if (!orderIds.length) return {};
    const client = await db();
    const out = {};
    for (let i = 0; i < orderIds.length; i += 80) {
      const chunk = orderIds.slice(i, i + 80);
      const { data, error } = await client.from('payments').select('*').in('order_id', chunk);
      if (error) throw error;
      (data || []).forEach(p => { (out[p.order_id] = out[p.order_id] || []).push(p); });
    }
    return out;
  }

  /* ── dashboard stats (real DB numbers) ─────────────────────── */
  async function dashboardStats() {
    const client = await db();
    const { data, error } = await client.rpc('admin_dashboard_stats');
    if (error) throw error;
    return typeof data === 'string' ? JSON.parse(data) : data;
  }

  /* ── sales feed for POS analytics (incl. pos channel rows) ─── */
  async function recordPosSale(sale) {
    const client = await db();
    const { data: ord, error: e1 } = await client.rpc('next_order_number');
    if (e1) throw e1;
    const { data: order, error: e2 } = await client.from('orders').insert({
      order_number: ord, customer_name: sale.customer || 'Walk-in customer', customer_phone: sale.phone || '-',
      delivery_area: 'In-store pickup', subtotal: sale.subtotal, delivery_fee: 0, total: sale.total,
      payment_method: (sale.payMethod || 'cash').toLowerCase(), payment_status: 'paid',
      status: 'delivered', channel: 'pos', stock_released: true
    }).select().single();
    if (e2) throw e2;
    const items = (sale.items || []).map(i => ({
      order_id: order.id, product_id: i.product_id || null, product_name: i.name,
      sku: i.sku || null, unit_price: i.price, quantity: i.qty, line_total: (i.price * i.qty)
    }));
    if (items.length) {
      const { error: e3 } = await client.from('order_items').insert(items);
      if (e3) throw e3;
    }
    const { error: e4 } = await client.from('payments').insert({
      order_id: order.id, amount: sale.total, method: (sale.payMethod || 'cash').toLowerCase(),
      status: 'paid', provider: 'pos', transaction_id: sale.id || null
    });
    if (e4) throw e4;
    return order;
  }

  async function recentSalesFeed(limit) {
    const client = await db();
    const { data, error } = await client.from('orders')
      .select('*, order_items(*)').in('channel', ['pos', 'web'])
      .order('created_at', { ascending: false }).limit(limit || 60);
    if (error) throw error;
    return data || [];
  }

  async function adjustStock(productId, delta) {
    const client = await db();
    const { data: cur, error: e } = await client.from('products').select('stock').eq('id', productId).maybeSingle();
    if (e) throw e;
    if (!cur) throw new Error('Product not found.');
    const next = Math.max(0, (cur.stock || 0) + delta);
    const { error: e2 } = await client.from('products').update({ stock: next, updated_at: new Date().toISOString() }).eq('id', productId);
    if (e2) throw e2;
    return next;
  }

  /* ── newsletter, users, content ────────────────────────────── */
  async function listSubscribers() {
    const client = await db();
    const { data, error } = await client.from('newsletter_subscribers').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }
  async function removeSubscriber(id) {
    const client = await db();
    const { error } = await client.from('newsletter_subscribers').delete().eq('id', id);
    if (error) throw error;
    return true;
  }
  async function listUsers() {
    const client = await db();
    const { data, error } = await client.from('profiles').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }
  async function setUserRole(userId, role) {
    const client = await db();
    const { error } = await client.rpc('admin_set_user_role', { p_user_id: userId, p_role: role });
    if (error) throw error;
    return true;
  }
  async function setAccountStatus(userId, status) {
    const client = await db();
    const { error } = await client.rpc('admin_set_account_status', { p_user_id: userId, p_status: status });
    if (error) throw error;
    return true;
  }
  async function createStaffUser(email, fullName, password, role) {
    const client = await db();
    if (!isAdmin(await currentProfile())) throw new Error('Only an admin can create staff accounts.');
    const { data, error } = await client.auth.admin.createUser({
      email, password, email_confirm: true,
      data: { full_name: fullName, role: role || 'staff' }
    });
    if (error) throw new Error(error.message);
    if (data.user) {
      await client.from('profiles').update({ first_name: fullName, role: role || 'staff' }).eq('id', data.user.id);
    }
    return data.user;
  }

  async function listJournal() {
    const client = await db();
    const { data, error } = await client.from('journal_posts').select('*').order('created_at', { ascending: false });
    if (error) throw error; return data || [];
  }
  async function saveJournal(post) {
    const client = await db();
    const row = {
      slug: post.slug, title: post.title, excerpt: post.excerpt || '', body: post.body || '',
      cover_image: post.cover_image || null, tags: post.tags || [], published: !!post.published,
      published_at: post.published ? (post.published_at || new Date().toISOString()) : post.published_at,
      updated_at: new Date().toISOString()
    };
    let res;
    if (post.id) res = await client.from('journal_posts').update(row).eq('id', post.id);
    else res = await client.from('journal_posts').insert(row);
    if (res.error) throw res.error;
    return true;
  }
  async function deleteJournal(id) {
    const client = await db();
    const { error } = await client.from('journal_posts').delete().eq('id', id);
    if (error) throw error; return true;
  }
  async function listCampaigns() {
    const client = await db();
    const { data, error } = await client.from('campaigns').select('*').order('sort_order');
    if (error) throw error; return data || [];
  }
  async function saveCampaign(c) {
    const client = await db();
    const row = {
      slug: c.slug, title: c.title, subtitle: c.subtitle || '', season: c.season || '',
      image_url: c.image_url || null, accent: c.accent || '#ff8c00', background: c.background || '#0d0c12',
      shape: c.shape || 'hoodie', link_url: c.link_url || null, sort_order: c.sort_order || 0,
      published: c.published !== false, updated_at: new Date().toISOString()
    };
    let res;
    if (c.id) res = await client.from('campaigns').update(row).eq('id', c.id);
    else res = await client.from('campaigns').insert(row);
    if (res.error) throw res.error; return true;
  }
  async function deleteCampaign(id) {
    const client = await db();
    const { error } = await client.from('campaigns').delete().eq('id', id);
    if (error) throw error; return true;
  }

  async function staffNotifications(limit) {
    const client = await db();
    const { data, error } = await client.from('notifications').select('*')
      .eq('audience', 'staff').order('created_at', { ascending: false }).limit(limit || 30);
    if (error) throw error;
    return data || [];
  }

  async function listDeliveryAreas() {
    const client = await db();
    const { data, error } = await client.from('delivery_areas').select('*').order('sort_order');
    if (error) throw error; return data || [];
  }
  async function saveDeliveryArea(a) {
    const client = await db();
    const row = { name: a.name, fee: Number(a.fee) || 0, free_over: a.free_over ? Number(a.free_over) : null, active: a.active !== false, sort_order: a.sort_order || 0 };
    const { error } = await client.from('delivery_areas').upsert(row, { onConflict: 'name' });
    if (error) throw error; return true;
  }

  window.DC_Admin = {
    db, currentSession, currentProfile, isStaff, isAdmin, signIn, signOut,
    listProducts, upsertProduct, deleteProduct, setProductFlags,
    listVariants, saveVariant, deleteVariant,
    uploadProductImage, deleteStoredImage, sniffImage,
    listOrders, updateOrderStatus, verifyPayment, paymentsFor,
    dashboardStats, recordPosSale, recentSalesFeed, adjustStock,
    listSubscribers, removeSubscriber, listUsers, setUserRole, setAccountStatus, createStaffUser,
    listJournal, saveJournal, deleteJournal, listCampaigns, saveCampaign, deleteCampaign,
    staffNotifications, listDeliveryAreas, saveDeliveryArea
  };
})();
