-- Drip Closet production hardening
-- The first admin already exists in production, so the bootstrap RPC must not be
-- callable by arbitrary authenticated users anymore.
REVOKE EXECUTE ON FUNCTION public.claim_bootstrap_admin() FROM anon, authenticated;

-- FK lookups and joins from order_items to products should have an index.
CREATE INDEX IF NOT EXISTS order_items_product_id_idx
  ON public.order_items (product_id);
