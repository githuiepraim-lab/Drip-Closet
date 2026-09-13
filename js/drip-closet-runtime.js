/* Drip Closet production runtime bridge.
 * Makes Supabase the cross-device product source of truth while preserving the existing UI.
 */
(function(){
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  async function loadProducts(){
    try{
      const api=window.DripClosetProducts;
      if(!api) return;
      const rows=await api.list({includeInactive:false});
      window.DC_DB_PRODUCTS=rows;
      if(!rows.length) return;
      try{ window.prods=rows; }catch(e){}
      try{ if(Array.isArray(window.products)) window.products=rows; }catch(e){}
      if(typeof window.renderProds==='function'){
        try{ window.renderProds(window.currentCat || 'all'); }catch(e){ try{window.renderProds('all')}catch(_){} }
      }
      document.dispatchEvent(new CustomEvent('dripcloset:products-loaded',{detail:{products:rows}}));
    }catch(e){ console.error('[Drip Closet] product sync failed',e); }
  }
  async function migrateLegacyProducts(){
    try{
      const api=window.DripClosetProducts; if(!api) return;
      const raw=localStorage.getItem('dc_web_products_v1');
      if(!raw) return;
      const local=JSON.parse(raw); if(!Array.isArray(local)||!local.length) return;
      const existing=await api.list({includeInactive:true});
      const names=new Set(existing.map(p=>String(p.name||'').trim().toLowerCase()));
      for(const p of local){
        const name=String(p.name||'').trim();
        if(!name || names.has(name.toLowerCase())) continue;
        if(!Number.isFinite(Number(p.price))) continue;
        const candidate={name,description:String(p.description||''),category:String(p.category||'Uncategorized'),price:Number(p.price)||0,compare_at_price:p.compare_at_price==null?null:Number(p.compare_at_price)||null,stock:Number(p.stock)||0,sizes:Array.isArray(p.sizes)?p.sizes:[],images:Array.isArray(p.images)?p.images:[],featured:!!p.featured,active:p.active!==false,gender:p.gender||null,shape:p.shape||null,badge:p.badge||null,badge_text:p.badge_text||null,accent:p.accent||null,background:p.background||null,stars:Number(p.stars)||5};
        try{ await api.create(candidate); names.add(name.toLowerCase()); }catch(err){ console.warn('[Drip Closet] legacy product migration skipped',name,err); }
      }
    }catch(e){ console.warn('[Drip Closet] legacy migration failed',e); }
  }
  async function boot(){
    await sleep(300);
    if(!window.getDripClosetSupabase || !window.DripClosetProducts) return;
    await migrateLegacyProducts();
    await loadProducts();
    setInterval(loadProducts,30000);
  }
  window.DripClosetRuntime={loadProducts,migrateLegacyProducts};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
})();
