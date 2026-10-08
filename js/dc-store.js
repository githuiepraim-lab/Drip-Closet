/* ═══════════════════════════════════════════════════════════════
 * DRIP CLOSET — storefront data layer (Supabase is the source of truth)
 * Public key only; every rule below is also enforced by RLS on the server.
 * ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  async function db() {
    const client = await window.getDripClosetSupabase();
    if (!client) throw new Error('Connection to the Drip Closet servers failed. Check your internet and retry.');
    return client;
  }

  /* ── row → legacy UI shape mapping ─────────────────────────── */
  function shapeFromName(name) {
    const n = String(name || '').toLowerCase();
    if (/hoodie|fleece/.test(n)) return 'hoodie';
    if (/cargo|pant|trouser/.test(n)) return 'cargo';
    if (/bomber|jacket/.test(n)) return 'bomber';
    if (/dress/.test(n)) return 'dress';
    if (/set|co-ord|coord/.test(n)) return 'set';
    if (/denim/.test(n)) return 'denim';
    if (/crop/.test(n)) return 'crop';
    if (/cap|hat|beanie/.test(n)) return 'tee';
    return 'tee';
  }
  const ACCENTS = ['#ff8c00', '#4466ff', '#cc44aa', '#00c4a7', '#ff5544', '#9966ff'];
  const BGS = ['#0d0c12', '#080810', '#100808', '#0c0c10', '#0e0812', '#060e0c'];
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

  function starsOf(rating) {
    const r = Math.round(Number(rating) || 5);
    return '★★★★★'.slice(0, r) + '☆☆☆☆☆'.slice(0, 5 - r);
  }

  function normalize(row) {
    const id = String(row.id);
    const images = Array.isArray(row.images) ? row.images.filter(Boolean) : [];
    const g = (row.gender || 'unisex').toLowerCase();
    const badge = row.badge || (row.featured ? 'hot' : null);
    const btxtMap = { hot: '🔥 HOT', new: 'NEW', sale: 'SALE' };
    const h = hashStr(id + (row.name || ''));
    return Object.assign({}, row, {
      id,
      uid: id,
      name: row.name,
      cat: row.category || 'New Arrival',
      price: Number(row.sale_price != null ? row.sale_price : row.price) || 0,
      listPrice: Number(row.price) || 0,
      was: row.sale_price != null && Number(row.sale_price) < Number(row.price) ? Number(row.price) : null,
      g: ['men', 'women', 'unisex'].includes(g) ? g : 'unisex',
      sh: row.shape || shapeFromName(row.name),
      sz: Array.isArray(row.sizes) && row.sizes.length ? row.sizes : ['One Size'],
      colors: Array.isArray(row.colors) ? row.colors : [],
      stock: Number(row.stock) || 0,
      sku: row.sku || null,
      desc: row.description || '',
      badge,
      btxt: row.badge_text || (badge ? (btxtMap[badge] || badge.toUpperCase()) : ''),
      stars: starsOf(row.rating),
      featured: !!row.featured,
      active: row.published != null ? !!row.published : row.active !== false,
      ac: row.accent || ACCENTS[h % ACCENTS.length],
      bg: row.background || BGS[h % BGS.length],
      img: images[0] || null,
      images,
      photos: images.map((u, i) => ({ dataUrl: u, name: 'Photo ' + (i + 1), isUrl: true }))
    });
  }

  /* ── error text from Postgres/RLS ──────────────────────────── */
  function friendlyError(error) {
    const m = String((error && error.message) || 'Unknown error');
    if (/STOCK:/i.test(m)) return m.replace(/^.*?STOCK:\s*/i, '⚠️ ').replace(/%[\d\s]*left/i, 'left');
    if (/UNAVAILABLE:/i.test(m)) return '⚠️ ' + m.replace(/^.*?UNAVAILABLE:\s*/i, '');
    if (/VALIDATION:/i.test(m)) return '⚠️ ' + m.replace(/^.*?VALIDATION:\s*/i, '');
    if (/CONFLICT:/i.test(m)) return '⚠️ ' + m.replace(/^.*?CONFLICT:\s*/i, '');
    if (/FORBIDDEN/i.test(m)) return '⛔ Access denied: ' + m.replace(/^.*?FORBIDDEN:\s*/i, '');
    if (/duplicate key/i.test(m)) return 'That record already exists.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Network error — could not reach Drip Closet servers.';
    return m;
  }
  window.DC_ERR_TEXT = friendlyError;

  /* ── products ──────────────────────────────────────────────── */
  async function fetchProducts(includeInactive) {
    const client = await db();
    let q = client.from('products').select('*').order('created_at', { ascending: false });
    if (!includeInactive) q = q.or('published.eq.true,active.eq.true');
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(normalize);
  }

  async function fetchVariants(productIds) {
    if (!productIds || !productIds.length) return {};
    const client = await db();
    const out = {};
    // chunk to stay inside URL length limits
    for (let i = 0; i < productIds.length; i += 80) {
      const chunk = productIds.slice(i, i + 80);
      const { data, error } = await client.from('product_variants')
        .select('*').in('product_id', chunk).order('size');
      if (error) throw error;
      (data || []).forEach(v => { (out[v.product_id] = out[v.product_id] || []).push(v); });
    }
    return out;
  }

  /* ── cart (guest localStorage + signed-in server rows) ─────── */
  const BAG_KEY = 'dc_bag_v2';
  function loadGuestBag() { try { const b = JSON.parse(localStorage.getItem(BAG_KEY)); return Array.isArray(b) ? b : []; } catch { return []; } }
  function saveGuestBag(bag) { try { localStorage.setItem(BAG_KEY, JSON.stringify(bag)); } catch {} }

  async function loadServerCart(userId) {
    const client = await db();
    const { data, error } = await client.from('cart_items')
      .select('*, products(*)').eq('user_id', userId).order('created_at');
    if (error) throw error;
    return (data || []).filter(r => r.products).map(r => ({
      id: String(r.product_id), variantId: r.variant_id || null,
      size: r.size, color: r.color, quantity: r.quantity
    }));
  }

  async function mergeGuestCartIntoUser(guestBag) {
    const client = await db();
    const { data: { user } } = await client.auth.getUser();
    if (!user || !guestBag.length) return;
    const existing = await loadServerCart(user.id).catch(() => []);
    const keyOf = l => `${l.id}|${l.variantId || ''}`;
    const have = new Set(existing.map(keyOf));
    const rows = [];
    guestBag.forEach(l => {
      if (!l.id || have.has(keyOf(l))) return;
      rows.push({ user_id: user.id, product_id: l.id, variant_id: l.variantId || null, size: l.size || null, color: l.color || null, quantity: l.quantity || 1 });
    });
    if (rows.length) {
      const { error } = await client.from('cart_items').upsert(rows, { onConflict: 'user_id,product_id,variant_id' });
      if (error) console.warn('[DC] cart merge failed', error);
    }
  }

  /* Persist the whole bag for a signed-in customer (server-side cart).
   * Called whenever the bag changes while logged in. */
  async function saveServerCart(bag) {
    const client = await db();
    const { data: { session } } = await client.auth.getSession();
    if (!session) return false;
    const rows = (bag || []).filter(l => l && l.id).map(l => ({
      user_id: session.user.id, product_id: l.id, variant_id: l.variantId || null,
      size: l.size || null, color: l.color || null, quantity: Math.max(1, l.quantity || 1)
    }));
    // wipe then insert so removals/qty changes are reflected exactly
    const { error: delErr } = await client.from('cart_items').delete().eq('user_id', session.user.id);
    if (delErr) throw delErr;
    if (rows.length) {
      const { error } = await client.from('cart_items').insert(rows);
      if (error) throw error;
    }
    return true;
  }

  /* Merge server cart rows into the local bag after sign-in. */
  function mergeCarts(serverLines, guestBag) {
    const map = new Map();
    const add = l => {
      const k = `${l.id}|${l.variantId || ''}`;
      const ex = map.get(k);
      if (ex) ex.quantity = Math.min(50, ex.quantity + (l.quantity || 1));
      else map.set(k, Object.assign({}, l));
    };
    (serverLines || []).forEach(add);
    (guestBag || []).forEach(add);
    return Array.from(map.values());
  }

  /* ── wishlist ──────────────────────────────────────────────── */
  async function toggleWishlist(productId) {
    const client = await db();
    const { data: { session } } = await client.auth.getSession();
    if (!session) throw new Error('Please sign in to save wishlist items.');
    const { data: existing } = await client.from('wishlist_items')
      .select('id').eq('user_id', session.user.id).eq('product_id', productId).maybeSingle();
    if (existing) {
      const { error } = await client.from('wishlist_items').delete().eq('id', existing.id);
      if (error) throw error;
      return { saved: false };
    }
    const { error } = await client.from('wishlist_items').insert({ user_id: session.user.id, product_id: productId });
    if (error) throw error;
    return { saved: true };
  }

  async function getWishlist() {
    const client = await db();
    const { data: { session } } = await client.auth.getSession();
    if (!session) return [];
    const { data, error } = await client.from('wishlist_items').select('product_id').eq('user_id', session.user.id);
    if (error) throw error;
    return (data || []).map(r => String(r.product_id));
  }

  /* ── newsletter ────────────────────────────────────────────── */
  async function subscribeNewsletter(email, source) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) throw new Error('Please enter a valid email address.');
    const client = await db();
    const { error } = await client.from('newsletter_subscribers')
      .upsert({ email: String(email).trim().toLowerCase(), source: source || 'website' }, { onConflict: 'email' });
    if (error) throw error;
    return true;
  }

  /* ── orders ────────────────────────────────────────────────── */
  async function myOrders() {
    const client = await db();
    const { data: { session } } = await client.auth.getSession();
    if (!session) return [];
    const { data, error } = await client.from('orders')
      .select('*, order_items(*)').eq('user_id', session.user.id)
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    return data || [];
  }

  async function cancelOrder(orderId, reason) {
    const client = await db();
    const { error } = await client.rpc('cancel_my_order', { p_order_id: orderId, p_reason: reason || null });
    if (error) throw error;
    return true;
  }

  async function submitPaymentProof(orderId, transactionId) {
    const client = await db();
    const { data: { session } } = await client.auth.getSession();
    if (!session) throw new Error('Sign in first.');
    const { data: ord } = await client.from('orders').select('id,total,payment_status,user_id').eq('id', orderId).maybeSingle();
    if (!ord || ord.user_id !== session.user.id) throw new Error('Order not found.');
    if (ord.payment_status === 'paid') return { alreadyPaid: true };
    const { data: pay } = await client.from('payments').select('id,status').eq('order_id', orderId).order('created_at').limit(1).maybeSingle();
    if (pay) {
      const { error } = await client.from('payments')
        .update({ transaction_id: String(transactionId || '').trim().slice(0, 40), updated_at: new Date().toISOString() })
        .eq('id', pay.id);
      if (error) throw error;
    } else {
      const { error } = await client.from('payments')
        .insert({ order_id: orderId, amount: ord.total, method: ord.payment_method || 'kcb_paybill', status: 'pending', transaction_id: String(transactionId || '').trim().slice(0, 40) });
      if (error) throw error;
    }
    return { ok: true };
  }

  async function notifications(limit) {
    const client = await db();
    const { data: { session } } = await client.auth.getSession();
    if (!session) return [];
    const { data, error } = await client.from('notifications')
      .select('*').eq('user_id', session.user.id)
      .order('created_at', { ascending: false }).limit(limit || 20);
    if (error) throw error;
    return data || [];
  }

  /* ── delivery areas & payment info (server-authoritative) ──── */
  async function deliveryAreas() {
    const client = await db();
    const { data, error } = await client.from('delivery_areas').select('name,fee,free_over').eq('active', true).order('sort_order');
    if (error) throw error;
    return data || [];
  }

  async function paymentInstructions() {
    const client = await db();
    const { data, error } = await client.from('app_settings').select('value').eq('key', 'payment_instructions').maybeSingle();
    if (error || !data) return null;
    return data.value;
  }

  /* ── lookbook campaigns ────────────────────────────────────── */
  async function campaigns() {
    const client = await db();
    const { data, error } = await client.from('campaigns').select('*').eq('published', true).order('sort_order');
    if (error) throw error;
    return data || [];
  }

  /* ── journal posts ─────────────────────────────────────────── */
  async function journalPosts() {
    const client = await db();
    const { data, error } = await client.from('journal_posts').select('*').eq('published', true).order('published_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  /* ── checkout: sends IDs ONLY; server prices everything ────── */
  async function createOrder(details) {
    const client = await db();
    const lines = (details.lines || []).map(l => ({
      product_id: l.id, variant_id: l.variantId || null, quantity: l.quantity || 1
    }));
    const { data, error } = await client.rpc('create_web_order', {
      p_customer_name: details.name,
      p_customer_phone: details.phone,
      p_customer_email: details.email || null,
      p_delivery_area: details.area,
      p_delivery_address: details.address || null,
      p_notes: details.notes || null,
      p_payment_method: details.paymentMethod || 'kcb_paybill',
      p_lines: lines
    });
    if (error) throw error;
    return typeof data === 'string' ? JSON.parse(data) : data;
  }

  window.DC_Store = {
    normalize, fetchProducts, fetchVariants,
    loadGuestBag, saveGuestBag, loadServerCart, mergeGuestCartIntoUser, saveServerCart, mergeCarts,
    toggleWishlist, getWishlist, subscribeNewsletter,
    myOrders, cancelOrder, submitPaymentProof, notifications,
    deliveryAreas, paymentInstructions, campaigns, journalPosts,
    createOrder, friendlyError, db
  };
})();
