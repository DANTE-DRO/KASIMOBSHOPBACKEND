# KASIMOB Backend

Node.js/Express server for KASIMOB e-commerce with:
- M-Pesa Daraja STK Push (sandbox by default)
- SQLite persistent storage (orders, customers, cart logs)
- Session-based admin authentication (survives refresh & logout)
- Admin dashboard at `/admin`

## Local development

```bash
npm install
npm start
```

Server runs on `http://localhost:10000` and admin panel at `http://localhost:10000/admin`.

## Environment variables (set these on Render)

| Variable | Description | Default (sandbox) |
|---|---|---|
| `PORT` | Auto-set by Render | 10000 |
| `MPESA_CONSUMER_KEY` | Daraja consumer key | (sandbox key included) |
| `MPESA_CONSUMER_SECRET` | Daraja consumer secret | (sandbox secret included) |
| `MPESA_SHORTCODE` | Daraja shortcode | 174379 |
| `MPESA_PASSKEY` | Daraja passkey | (sandbox passkey included) |
| `MPESA_BASE_URL` | Daraja API base | https://sandbox.safaricom.co.ke |
| `MPESA_CALLBACK_URL` | Your Render URL + /api/mpesa-callback | (set after deploy) |
| `ADMIN_PASSWORD` | Admin panel password | 11kasisi72 |
| `SESSION_SECRET` | Change to a long random string | (default) |

## Deploy to Render.com

1. Push these files (`server.js`, `admin.html`, `package.json`) to a GitHub repo.
2. On Render.com → New → Web Service → connect that repo.
3. Set:
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free (or paid for persistence)
4. Add a **Disk** in the Render service → mount path `/var/data`, size 1 GB (this gives you permanent storage that survives restarts).
5. Add env vars from the table above.
6. After first deploy, copy your Render URL (e.g. `https://kasimob-backend.onrender.com`) and:
   - Set env var `MPESA_CALLBACK_URL` to `<your-url>/api/mpesa-callback`
   - Update the frontend `app.js` → `BACKEND_URL` to that URL
   - Redeploy

## Endpoints

- `GET  /health` – health check
- `POST /api/stk-push` – trigger STK push
- `POST /api/mpesa-callback` – Daraja callback (public)
- `POST /api/cart-log` – log cart activity
- `POST /api/admin/login` – login (body: `{password}`)
- `POST /api/admin/logout` – logout
- `GET  /api/admin/me` – check session
- `GET  /api/admin/orders` – list orders (admin)
- `GET  /api/admin/customers` – list customers (admin)
- `GET  /api/admin/carts` – list cart activity (admin)
- `GET  /api/admin/stats` – dashboard stats (admin)
- `GET  /admin` – admin panel UI
