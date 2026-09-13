# Drip Closet 🧥🔥

**Nairobi Streetwear Brand** — Supabase-backed ecommerce system.

## Applications

| File | Purpose |
|------|---------|
| `drip_closet_website.html` | Customer storefront |
| `drip_closet_admin.html` | Admin product/order management |
| `drip_closet_pos.html` | POS interface |
| `drip_closet_photoshop.html` | Product image preparation |

## Backend

The production backend is Supabase project `cezhlycsuecrvwfxbrpg`.

- Supabase Auth — customer/admin authentication
- PostgreSQL — products, profiles, orders, order items and wishlists
- Supabase Storage — persistent product images
- Edge Functions — server-side AI/image workflows
- Row Level Security — database authorization

The browser must never contain a Supabase service-role/secret key. Only the public/publishable key belongs in frontend code, with RLS providing authorization.

## Development

Do not use localStorage as the authoritative product, inventory, customer, order or image database. Browser storage may be used only for non-authoritative UI state such as a temporary cart/cache.

Database changes belong in `supabase/migrations/` and should be deployed through the connected Supabase project.

## Production configuration

Configure the real deployed storefront URL in Supabase Authentication → URL Configuration. Add every production callback/reset URL to the allowed Redirect URLs. Do not use `localhost` as the production Site URL.

## Security

- Admin authorization is determined by the authenticated Supabase user and the `profiles.role` value.
- Product CRUD is protected by RLS.
- Product images belong in Supabase Storage, not permanent browser data URLs.
- Bootstrap-admin functionality is disabled after the initial administrator is established.

## Location

📍 Machakos, near Machakos University — opposite Club Legend

## Payment

KCB Pay Bill: **522522** · Account: **1355793491**

## WhatsApp

0112 960 896

---
Made in Nairobi 🇰🇪 · Wear What You Feel
