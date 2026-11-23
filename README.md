# PizzaHub - Server (Express API)

REST API for PizzaHub: menu items, orders, admin tools and Stripe subscriptions. Authentication is handled by Better Auth in the client app; this server verifies the Better Auth **JWT** on every protected route.

- **Live API:** https://YOUR-SERVER.onrender.com
- **Client repo:** https://github.com/YOUR-USERNAME/pizzahub-client
- **Server repo:** https://github.com/YOUR-USERNAME/pizzahub-server

## Important features
- JWT verification middleware (JWKS) + role middleware (admin / vendor / customer), 401 vs 403 responses
- Ownership checks on every update/delete, server-side validation, atomic order status changes
- Free plan limit (3 active items), Premium unlimited
- Stripe Checkout (subscription mode) + **webhook** that activates Premium, records renewals, handles cancellation and expiry
- Read-only transactions for admins (no update/delete routes exist)

## Tech stack
`express`, `cors`, `dotenv`, `mongodb`, `jose`, `stripe`

## Environment variables
| Name | Purpose |
|------|---------|
| `PORT` | Server port (default 5000) |
| `MONGODB_URI`, `DB_NAME` | MongoDB Atlas (same DB as the client) |
| `CLIENT_URL` | Client origin (CORS, JWKS URL, Stripe redirects) |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint |
| `PREMIUM_PRICE_CENTS`, `PREMIUM_CURRENCY` | Premium price (default 999 / usd) |

## Installation and running locally
```bash
git clone https://github.com/YOUR-USERNAME/pizzahub-server.git
cd pizzahub-server
npm install
cp .env.example .env     # fill in the values
npm run dev              # http://localhost:5000
```
Stripe webhook locally: `stripe listen --forward-to localhost:5000/api/payments/webhook` and copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`.
In production add a webhook endpoint `https://YOUR-SERVER/api/payments/webhook` with events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`.

## API overview
| Method | Path | Access |
|--------|------|--------|
| GET | `/api/menu`, `/api/menu/featured`, `/api/menu/meta`, `/api/menu/:id` | public (approved items only) |
| GET/POST/PUT/PATCH/DELETE | `/api/vendor/items...`, `/api/vendor/stats`, `/api/vendor/orders` | vendor |
| POST | `/api/orders` | customer |
| GET | `/api/orders/my`, `/api/customer/stats` | customer |
| PATCH | `/api/orders/:id/cancel` | customer (own pending order) |
| PATCH | `/api/orders/:id/status` | vendor (own pending order) |
| GET/PATCH/DELETE | `/api/admin/...` | admin |
| POST | `/api/payments/checkout`, `/api/payments/cancel-subscription` | vendor |
| POST | `/api/payments/webhook` | Stripe only (signature verified) |
| PATCH | `/api/profile` | any logged-in user (name, image, businessName only) |

## Challenge notes
**Advanced search/sort:** `GET /api/menu?search=&category=&location=&minPrice=&maxPrice=&sort=price_asc|price_desc|newest&page=&limit=`.

**JWT middleware flow:** `Authorization: Bearer` -> `jwtVerify` with remote JWKS (`CLIENT_URL/api/auth/jwks`) -> load user from `users` collection -> blocked check -> `requireRole`. Expired or invalid tokens return 401.
