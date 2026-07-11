/* =========================================================
   KASIMOB Backend Server - COMPLETE / FIXED FOR RENDER
   Node.js + Express + M-Pesa Daraja API + SQLite
   =========================================================
   Fixes:
    - Restored ALL missing admin routes (stats, orders,
      customers, carts, delete order, logout).
    - Restored cart-log endpoint used by frontend.
    - Added user auth (email/password + Google sign-in).
    - Safer sqlite path + graceful startup on Render.
   ========================================================= */

const express       = require('express');
const cors          = require('cors');
const session       = require('express-session');
const SQLiteStore   = require('connect-sqlite3')(session);
const axios         = require('axios');
const path          = require('path');
const sqlite3       = require('sqlite3').verbose();
const fs            = require('fs');
const crypto        = require('crypto');

// ============ CONFIG ============
const PORT = process.env.PORT || 10000;

// M-Pesa Credentials
const MPESA_CONSUMER_KEY    = process.env.MPESA_CONSUMER_KEY    || 'k232eutaV7AgV8jgFGJkKghNFeMlwZp2Bfq9Q1GFwRF0puc9';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || 'LxKcEVb5WwZXzr3keUFul3LaLVwE0F4OuAOeVbYa6gfzoKPWQJH5Kd1EtYZsekTy';
const MPESA_SHORTCODE       = process.env.MPESA_SHORTCODE       || '174379';
const MPESA_PASSKEY         = process.env.MPESA_PASSKEY         || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const MPESA_BASE_URL        = process.env.MPESA_BASE_URL        || 'https://sandbox.safaricom.co.ke';
const MPESA_CALLBACK_URL    = process.env.MPESA_CALLBACK_URL    || 'https://kasimobshopbackend.onrender.com/api/mpesa-callback';

const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || '11kasisi72';
const SESSION_SECRET  = process.env.SESSION_SECRET  || 'kasimob_super_secret_change_me';

// Google Sign-In (optional). If GOOGLE_CLIENT_ID is not set,
// the /api/auth/google endpoint will return 501 and the frontend
// will silently hide the Google button.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// ============ APP ============
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Data Directory
const DATA_DIR = process.env.DATA_DIR
  || (fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data'));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const isProd = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

// Trust the Render proxy so secure cookies work
if (isProd) app.set('trust proxy', 1);

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
  },
}));

// ============ DATABASE ============
const dbPath = path.join(DATA_DIR, 'kasimob.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
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
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cart_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      items TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      name TEXT,
      phone TEXT,
      location TEXT,
      total_orders INTEGER DEFAULT 0,
      total_spent REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Users (for email/password + Google sign-in)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT,
      password_salt TEXT,
      google_id TEXT,
      picture TEXT,
      provider TEXT DEFAULT 'local',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    )
  `);
});

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

function requireUser(req, res, next) {
  if (req.session.userId) return next();
  return res.status(401).json({ error: 'Please sign in to continue.' });
}

// Password hashing (scrypt — Node built-in, no extra deps)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const test = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

// Upsert customer aggregate (called on successful payment)
function upsertCustomerOnPaid(email, name, phone, location, amount) {
  if (!email) return;
  db.get('SELECT id FROM customers WHERE email = ?', [email], (err, row) => {
    if (err) return console.error('customer lookup', err);
    if (row) {
      db.run(
        `UPDATE customers
           SET total_orders = total_orders + 1,
               total_spent  = total_spent + ?,
               name  = COALESCE(NULLIF(?, ''), name),
               phone = COALESCE(NULLIF(?, ''), phone),
               location = COALESCE(NULLIF(?, ''), location)
           WHERE email = ?`,
        [amount || 0, name || '', phone || '', location || '', email]
      );
    } else {
      db.run(
        `INSERT INTO customers (email, name, phone, location, total_orders, total_spent)
         VALUES (?, ?, ?, ?, 1, ?)`,
        [email, name || '', phone || '', location || '', amount || 0]
      );
    }
  });
}

// ============ ROUTES ============
app.get('/', (req, res) => {
  res.json({ name: 'KASIMOB Backend', status: 'running', version: '1.2.0' });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Expose Google Client ID to the frontend (safe — it's public)
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
});

// ============ AUTH: USER (email/password + Google) ============

// Sign up (email + password)
app.post('/api/auth/signup', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const em = String(email).trim().toLowerCase();

  db.get('SELECT id FROM users WHERE email = ?', [em], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    if (row) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });

    const { salt, hash } = hashPassword(password);
    db.run(
      `INSERT INTO users (email, name, password_hash, password_salt, provider, last_login)
       VALUES (?, ?, ?, ?, 'local', CURRENT_TIMESTAMP)`,
      [em, name || '', hash, salt],
      function (err2) {
        if (err2) return res.status(500).json({ error: 'Could not create account.' });
        req.session.userId = this.lastID;
        req.session.userEmail = em;
        req.session.userName = name || '';
        res.json({ success: true, user: { id: this.lastID, email: em, name: name || '', provider: 'local' } });
      }
    );
  });
});

// Sign in (email + password)
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const em = String(email).trim().toLowerCase();
  db.get('SELECT * FROM users WHERE email = ?', [em], (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!verifyPassword(password, user.password_salt, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    req.session.userId    = user.id;
    req.session.userEmail = user.email;
    req.session.userName  = user.name || '';
    db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    res.json({ success: true, user: { id: user.id, email: user.email, name: user.name || '', provider: user.provider, picture: user.picture } });
  });
});

// Google Sign-In (verifies ID token from Google Identity Services)
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });
  if (!GOOGLE_CLIENT_ID) {
    return res.status(501).json({ error: 'Google sign-in is not configured on the server. Set GOOGLE_CLIENT_ID env var.' });
  }

  try {
    // Verify the ID token via Google's tokeninfo endpoint (no extra deps)
    const { data: payload } = await axios.get(
      'https://oauth2.googleapis.com/tokeninfo',
      { params: { id_token: credential } }
    );

    // Basic checks
    if (payload.aud !== GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: 'Invalid Google credential (audience mismatch).' });
    }
    if (!payload.email || payload.email_verified === 'false') {
      return res.status(401).json({ error: 'Google email not verified.' });
    }

    const email    = String(payload.email).toLowerCase();
    const name     = payload.name || payload.given_name || '';
    const googleId = payload.sub;
    const picture  = payload.picture || '';

    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
      if (err) return res.status(500).json({ error: 'Database error.' });

      const finish = (u) => {
        req.session.userId    = u.id;
        req.session.userEmail = u.email;
        req.session.userName  = u.name || '';
        db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [u.id]);
        res.json({ success: true, user: { id: u.id, email: u.email, name: u.name || '', provider: 'google', picture: u.picture } });
      };

      if (user) {
        // Attach google_id / picture if this account was created locally
        db.run(
          `UPDATE users SET google_id = COALESCE(google_id, ?),
                            picture   = COALESCE(NULLIF(?, ''), picture),
                            name      = COALESCE(NULLIF(name, ''), ?)
           WHERE id = ?`,
          [googleId, picture, name, user.id]
        );
        finish(user);
      } else {
        db.run(
          `INSERT INTO users (email, name, google_id, picture, provider, last_login)
           VALUES (?, ?, ?, ?, 'google', CURRENT_TIMESTAMP)`,
          [email, name, googleId, picture],
          function (err2) {
            if (err2) return res.status(500).json({ error: 'Could not create account.' });
            finish({ id: this.lastID, email, name, picture });
          }
        );
      }
    });
  } catch (err) {
    console.error('Google verify error:', err.response?.data || err.message);
    res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
});

// Who am I
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  db.get('SELECT id, email, name, picture, provider FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err || !user) return res.json({ authenticated: false });
    res.json({ authenticated: true, user });
  });
});

// Logout user
app.post('/api/auth/logout', (req, res) => {
  req.session.userId = null;
  req.session.userEmail = null;
  req.session.userName = null;
  res.json({ success: true });
});

// ============ M-PESA ============

// STK Push — now requires the shopper to be signed in
app.post('/api/stk-push', requireUser, async (req, res) => {
  const { name, email, location, phone, amount, items } = req.body;

  if (!name || !email || !location || !phone || !amount) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
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
      Amount: Math.round(amount),
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

    // Save order (prefer signed-in email if present)
    const buyerEmail = (req.session.userEmail || email || '').toLowerCase();
    db.run(`
      INSERT INTO orders (order_id, name, email, location, phone, amount, items,
                          merchant_request_id, checkout_request_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `, [orderId, name, buyerEmail, location, phone, amount,
        JSON.stringify(items || []), data.MerchantRequestID, data.CheckoutRequestID]);

    res.json({ success: true, orderId, ...data });
  } catch (err) {
    console.error('STK Push error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data?.errorMessage || err.message });
  }
});

// M-Pesa Callback
app.post('/api/mpesa-callback', (req, res) => {
  console.log('Callback received:', JSON.stringify(req.body));
  try {
    const cb = req.body.Body?.stkCallback;
    if (!cb) return res.json({ ResultCode: 0 });

    const checkoutId = cb.CheckoutRequestID;
    const resultCode = cb.ResultCode;
    const items = cb.CallbackMetadata?.Item || [];
    const receipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value || null;
    const status = resultCode === 0 ? 'PAID' : 'FAILED';

    db.run(
      `UPDATE orders SET status=?, mpesa_receipt=?, updated_at=CURRENT_TIMESTAMP
         WHERE checkout_request_id=?`,
      [status, receipt, checkoutId]
    );

    // If PAID, roll the customer aggregate
    if (status === 'PAID') {
      db.get('SELECT * FROM orders WHERE checkout_request_id = ?', [checkoutId], (err, row) => {
        if (!err && row) {
          upsertCustomerOnPaid(row.email, row.name, row.phone, row.location, row.amount);
        }
      });
    }
  } catch (e) {
    console.error('Callback error:', e);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Cart activity log (used by frontend)
app.post('/api/cart-log', (req, res) => {
  const { sessionId, items } = req.body || {};
  if (!sessionId) return res.json({ success: false });
  db.run(
    `INSERT INTO cart_logs (session_id, items) VALUES (?, ?)`,
    [sessionId, JSON.stringify(items || [])]
  );
  res.json({ success: true });
});

// ============ ADMIN ============
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

app.get('/api/admin/me', (req, res) => res.json({ isAdmin: !!req.session.isAdmin }));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const stats = {
    totalOrders: 0, paidOrders: 0, totalRevenue: 0,
    totalCustomers: 0, totalCarts: 0,
  };
  db.get('SELECT COUNT(*) AS c FROM orders', (e1, r1) => {
    stats.totalOrders = r1?.c || 0;
    db.get(`SELECT COUNT(*) AS c FROM orders WHERE status='PAID'`, (e2, r2) => {
      stats.paidOrders = r2?.c || 0;
      db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE status='PAID'`, (e3, r3) => {
        stats.totalRevenue = r3?.s || 0;
        db.get('SELECT COUNT(*) AS c FROM customers', (e4, r4) => {
          stats.totalCustomers = r4?.c || 0;
          db.get('SELECT COUNT(*) AS c FROM cart_logs', (e5, r5) => {
            stats.totalCarts = r5?.c || 0;
            res.json(stats);
          });
        });
      });
    });
  });
});

// Orders list
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  db.all(
    `SELECT * FROM orders ORDER BY datetime(created_at) DESC LIMIT 500`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const orders = (rows || []).map(r => {
        let items = [];
        try { items = JSON.parse(r.items || '[]'); } catch {}
        return { ...r, items };
      });
      res.json({ orders });
    }
  );
});

// Delete order
app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  db.run('DELETE FROM orders WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

// Customers list
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  db.all(
    `SELECT * FROM customers ORDER BY datetime(created_at) DESC LIMIT 500`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ customers: rows || [] });
    }
  );
});

// Cart logs
app.get('/api/admin/carts', requireAdmin, (req, res) => {
  db.all(
    `SELECT * FROM cart_logs ORDER BY datetime(timestamp) DESC LIMIT 200`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const carts = (rows || []).map(r => {
        let items = [];
        try { items = JSON.parse(r.items || '[]'); } catch {}
        return { ...r, items };
      });
      res.json({ carts });
    }
  );
});

// 404 (JSON) for unknown /api routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`✅ KASIMOB backend running on port ${PORT}`);
  console.log(`   Data directory: ${DATA_DIR}`);
  console.log(`   Google sign-in: ${GOOGLE_CLIENT_ID ? 'ENABLED' : 'disabled (set GOOGLE_CLIENT_ID)'}`);
});
