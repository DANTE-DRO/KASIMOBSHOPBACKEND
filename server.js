/* =========================================================
   KASIMOB Backend Server
   Node.js + Express + M-Pesa Daraja API + SQLite persistence
   Deploy on: render.com  (Web Service)
   ========================================================= */

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const axios = require('axios');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

// ============ CONFIG ============
const PORT = process.env.PORT || 10000;

// M-Pesa Daraja Sandbox Credentials (replace with real ones after Safaricom approval)
const MPESA_CONSUMER_KEY    = process.env.MPESA_CONSUMER_KEY    || 'k232eutaV7AgV8jgFGJkKghNFeMlwZp2Bfq9Q1GFwRF0puc9';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || 'LxKcEVb5WwZXzr3keUFul3LaLVwE0F4OuAOeVbYa6gfzoKPWQJH5Kd1EtYZsekTy';
const MPESA_SHORTCODE       = process.env.MPESA_SHORTCODE       || '174379';       // Sandbox shortcode
const MPESA_PASSKEY         = process.env.MPESA_PASSKEY         || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919'; // Sandbox passkey
const MPESA_BASE_URL        = process.env.MPESA_BASE_URL        || 'https://sandbox.safaricom.co.ke';
const MPESA_CALLBACK_URL    = process.env.MPESA_CALLBACK_URL    || 'https://kasimob-backend.onrender.com/api/mpesa-callback';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '11kasisi72';
const SESSION_SECRET = process.env.SESSION_SECRET || 'kasimob_super_secret_change_me';

// ============ APP ============
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Persistent session store (survives refresh & restart)
// On Render, use a persistent disk mounted at /var/data for full persistence.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data'));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.set('trust proxy', 1);
// Detect production (Render sets NODE_ENV or provides a public URL)
const isProd = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    // Cross-site cookies require SameSite=None + Secure. On http localhost we relax this.
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
  },
}));

// ============ DATABASE ============
const db = new Database(path.join(DATA_DIR, 'kasimob.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE,
  name TEXT,
  email TEXT,
  location TEXT,
  phone TEXT,
  amount REAL,
  items TEXT,
  merchant_request_id TEXT,
  checkout_request_id TEXT,
  status TEXT DEFAULT 'PENDING',
  mpesa_receipt TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cart_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  items TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  name TEXT,
  phone TEXT,
  location TEXT,
  total_orders INTEGER DEFAULT 0,
  total_spent REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// ============ HELPERS ============
function generateOrderId() {
  return 'KAS' + Date.now() + Math.floor(Math.random() * 1000);
}

async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const url = `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`;
  const { data } = await axios.get(url, { headers: { Authorization: `Basic ${auth}` } });
  return data.access_token;
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Unauthorized. Please login.' });
}

// ============ ROUTES: PUBLIC ============
app.get('/', (req, res) => {
  res.json({
    name: 'KASIMOB Backend',
    status: 'running',
    version: '1.0.0',
    endpoints: {
      stkPush: 'POST /api/stk-push',
      callback: 'POST /api/mpesa-callback',
      cartLog: 'POST /api/cart-log',
      admin: 'GET /admin',
    },
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ============ STK PUSH ============
app.post('/api/stk-push', async (req, res) => {
  const { name, email, location, phone, amount, items } = req.body;

  // Validation
  if (!name || !email || !location || !phone || !amount) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  if (!/^254\d{9}$/.test(phone)) {
    return res.status(400).json({ success: false, error: 'Phone must be in format 254XXXXXXXXX' });
  }
  if (amount < 1) {
    return res.status(400).json({ success: false, error: 'Amount must be at least 1 KES' });
  }

  const orderId = generateOrderId();

  try {
    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[-T:\.Z]/g, '').slice(0, 14);
    const password = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + timestamp).toString('base64');

    const stkPayload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),        // Daraja requires integer
      PartyA: phone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: orderId,
      TransactionDesc: `KASIMOB Order ${orderId}`,
    };

    const { data } = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      stkPayload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Persist order
    db.prepare(`
      INSERT INTO orders (order_id, name, email, location, phone, amount, items, merchant_request_id, checkout_request_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `).run(orderId, name, email, location, phone, amount, JSON.stringify(items || []), data.MerchantRequestID, data.CheckoutRequestID);

    // Upsert customer
    const existing = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
    if (existing) {
      db.prepare('UPDATE customers SET name=?, phone=?, location=?, total_orders=total_orders+1 WHERE email=?')
        .run(name, phone, location, email);
    } else {
      db.prepare('INSERT INTO customers (email, name, phone, location, total_orders) VALUES (?, ?, ?, ?, 1)')
        .run(email, name, phone, location);
    }

    return res.json({
      success: true,
      orderId,
      MerchantRequestID: data.MerchantRequestID,
      CheckoutRequestID: data.CheckoutRequestID,
      ResponseCode: data.ResponseCode,
      ResponseDescription: data.ResponseDescription,
      CustomerMessage: data.CustomerMessage,
    });
  } catch (err) {
    console.error('STK Push error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: err.response?.data?.errorMessage || err.message || 'STK push failed',
    });
  }
});

// ============ M-PESA CALLBACK ============
app.post('/api/mpesa-callback', (req, res) => {
  console.log('MPesa callback received:', JSON.stringify(req.body, null, 2));
  try {
    const cb = req.body.Body?.stkCallback;
    if (!cb) return res.json({ ok: true });

    const checkoutId = cb.CheckoutRequestID;
    const resultCode = cb.ResultCode;
    const items = cb.CallbackMetadata?.Item || [];
    const receipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value || null;

    const status = resultCode === 0 ? 'PAID' : 'FAILED';

    db.prepare('UPDATE orders SET status=?, mpesa_receipt=?, updated_at=CURRENT_TIMESTAMP WHERE checkout_request_id=?')
      .run(status, receipt, checkoutId);

    if (status === 'PAID') {
      const order = db.prepare('SELECT * FROM orders WHERE checkout_request_id=?').get(checkoutId);
      if (order) {
        db.prepare('UPDATE customers SET total_spent = total_spent + ? WHERE email = ?').run(order.amount, order.email);
      }
    }
  } catch (e) {
    console.error('Callback parse error:', e);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ============ CART LOGGING ============
app.post('/api/cart-log', (req, res) => {
  const { sessionId, items } = req.body;
  try {
    db.prepare('INSERT INTO cart_logs (session_id, items) VALUES (?, ?)')
      .run(sessionId || 'anonymous', JSON.stringify(items || []));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ ADMIN AUTH ============
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, error: 'Invalid password' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/admin/me', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// ============ ADMIN DATA ============
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all();
  orders.forEach(o => { try { o.items = JSON.parse(o.items || '[]'); } catch { o.items = []; } });
  res.json({ orders });
});

app.get('/api/admin/customers', requireAdmin, (req, res) => {
  const customers = db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
  res.json({ customers });
});

app.get('/api/admin/carts', requireAdmin, (req, res) => {
  const carts = db.prepare('SELECT * FROM cart_logs ORDER BY timestamp DESC LIMIT 200').all();
  carts.forEach(c => { try { c.items = JSON.parse(c.items || '[]'); } catch { c.items = []; } });
  res.json({ carts });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalOrders = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const paidOrders  = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='PAID'").get().n;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE status='PAID'").get().s;
  const totalCustomers = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  const totalCarts = db.prepare('SELECT COUNT(*) AS n FROM cart_logs').get().n;
  res.json({ totalOrders, paidOrders, totalRevenue, totalCustomers, totalCarts });
});

app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============ ADMIN UI ============
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ============ 404 ============
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

// ============ START ============
app.listen(PORT, () => {
  console.log(`✅ KASIMOB backend running on port ${PORT}`);
  console.log(`   Data directory: ${DATA_DIR}`);
  console.log(`   Admin URL: http://localhost:${PORT}/admin`);
});
