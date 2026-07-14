# KASIMOB Backend

Node.js/Express server for KASIMOB e-commerce with:
- M-Pesa Daraja STK Push (sandbox by default)
- SQLite persistent storage (orders, customers, cart logs, users, password resets)
- Session-based admin & user authentication (survives refresh & logout)
- Admin dashboard at `/admin` with Orders, Customers, Users, Cart Activity
- Order progress tracking (Placed → Processing → Packed → Shipped → Out for Delivery → Delivered)
- **Welcome email** on signup (email/password + Google)
- **Forgot password / reset password** flow (secure token, 60-minute expiry)
- **Receipt email** with downloadable HTML receipt when payment is confirmed
- Progress-update email to customer whenever admin changes the order stage

## Local development

```bash
npm install
npm start
```

Server runs on `http://localhost:10000` and admin panel at `http://localhost:10000/admin`.

## Environment variables (set these on Render)

### Required for M-Pesa
| Variable | Description | Default (sandbox) |
|---|---|---|
| `PORT` | Auto-set by Render | 10000 |
| `MPESA_CONSUMER_KEY` | Daraja consumer key | (sandbox key included) |
| `MPESA_CONSUMER_SECRET` | Daraja consumer secret | (sandbox secret included) |
| `MPESA_SHORTCODE` | Daraja shortcode | 174379 |
| `MPESA_PASSKEY` | Daraja passkey | (sandbox passkey included) |
| `MPESA_BASE_URL` | Daraja API base | https://sandbox.safaricom.co.ke |
| `MPESA_CALLBACK_URL` | Your Render URL + /api/mpesa-callback | (set after deploy) |

### Admin / session
| Variable | Description | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Admin panel password | 11kasisi72 |
| `SESSION_SECRET` | Change to a long random string | (default) |

### Google Sign-In (optional)
| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID. If unset, the Google button hides itself automatically. |

### Email (optional, required for welcome/receipt/forgot-password emails)

The server runs fine without SMTP configured — it will just skip sending
emails (logged as `📭 email skipped`). To turn on emails, set:

| Variable | Description | Example |
|---|---|---|
| `SMTP_HOST` | SMTP server host | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP port | `465` |
| `SMTP_SECURE` | `true` for 465, `false` for 587 | `true` |
| `SMTP_USER` | SMTP username | `kasisim388@gmail.com` |
| `SMTP_PASS` | SMTP password / **App Password** for Gmail | `xxxx xxxx xxxx xxxx` |
| `MAIL_FROM` | "From" header | `KASIMOB <kasisim388@gmail.com>` |
| `SHOP_EMAIL` | Contact email shown in emails | `kasisim388@gmail.com` |
| `PUBLIC_BASE_URL` | Public URL of this backend (used in receipt & reset links) | `https://kasimobshopbackend.onrender.com` |

#### Getting a Gmail App Password
1. In your Google Account → **Security** → turn on **2-Step Verification**.
2. Then Security → **App passwords** → create one for "Mail" / "Other".
3. Copy the 16-character password (with or without spaces) into `SMTP_PASS`.

## Deploy to Render.com

1. Push the `backend/` folder to a GitHub repo.
2. On Render → New → Web Service → connect the repo, pick the `backend` folder as root.
3. Set:
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
4. Add a **Disk** → mount path `/var/data`, size 1 GB (persistent SQLite storage).
5. Add env vars from the tables above.
6. After first deploy, copy your Render URL and:
   - Set env var `MPESA_CALLBACK_URL` = `<your-url>/api/mpesa-callback`
   - Set env var `PUBLIC_BASE_URL` = `<your-url>`
   - Update the frontend `app.js` → `BACKEND_URL` to that URL
   - Redeploy

## New endpoints (v1.3.0)

**Auth**
- `POST /api/auth/forgot` – request password reset link (body: `{email}`)
- `GET  /api/auth/reset/verify?token=...` – validate a reset token
- `POST /api/auth/reset` – set new password (body: `{token, password}`)
- `GET  /reset-password` – nice HTML page shown from reset-email link

**Shopper**
- `GET  /api/my-orders` – signed-in user's orders with progress (session required)
- `GET  /api/order/:orderId/status` – public order status lookup
- `GET  /api/receipt/:orderId` – printable HTML receipt (PAID orders only)

**Admin**
- `GET  /api/admin/users` – list registered users (accounts)
- `POST /api/admin/orders/:id/progress` – update order stage (body: `{progress}`) — also emails the customer
- `POST /api/admin/orders/:id/resend-receipt` – resend the receipt email

Allowed progress values: `Placed`, `Processing`, `Packed`, `Shipped`, `Out for Delivery`, `Delivered`, `Cancelled`.
