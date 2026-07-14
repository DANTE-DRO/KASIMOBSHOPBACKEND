/* =========================================================
   KASIMOB Backend Server - COMPLETE / FIXED FOR RENDER
   Node.js + Express + M-Pesa Daraja API + SQLite
   =========================================================
   v1.3.0 additions (nothing else changed in existing logic):
    - Welcome email on signup (nodemailer, SMTP)
    - Forgot / reset password (token via email, 60 min)
    - Receipt email + downloadable HTML receipt on PAID
    - Admin "Users" tab endpoint + order progress endpoints
    - Public order-status endpoint for shoppers
    - Email module is fully optional — server never crashes
      if SMTP env vars are missing (safe for Render redeploy)
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

// nodemailer is loaded lazily so a missing dep never crashes the server
let nodemailer = null;
try { nodemailer = require('nodemailer'); }
catch (e) { console.warn('⚠️  nodemailer not installed — email features disabled until it is.'); }

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

// -------- Email (SMTP) config --------
// Everything is optional; if not set, sendEmail() logs and returns instead of crashing.
const SMTP_HOST   = process.env.SMTP_HOST   || 'smtp.gmail.com';
const SMTP_PORT   = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_SECURE = (process.env.SMTP_SECURE || 'true') === 'true';   // true for 465, false for 587
const SMTP_USER   = process.env.SMTP_USER   || '';                    // e.g. kasisim388@gmail.com
const SMTP_PASS   = process.env.SMTP_PASS   || '';                    // Gmail App Password (16 chars)
const MAIL_FROM   = process.env.MAIL_FROM   || 'KASIMOB <kasisim388@gmail.com>';
const SHOP_EMAIL  = process.env.SHOP_EMAIL  || 'kasisim388@gmail.com';
// PUBLIC_BASE_URL is used in email links (reset password, receipt download)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://kasimobshopbackend.onrender.com';

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
      progress TEXT DEFAULT 'Placed',
      receipt_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Safe migrations for older DBs that don't have the new columns
  db.run(`ALTER TABLE orders ADD COLUMN progress TEXT DEFAULT 'Placed'`, () => {});
  db.run(`ALTER TABLE orders ADD COLUMN receipt_sent INTEGER DEFAULT 0`, () => {});

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

  // Password reset tokens
  db.run(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

// ============ EMAIL ============
// Build the transporter lazily. Never throws — returns null if not configured.
let _mailTransport = null;
function getMailer() {
  if (_mailTransport) return _mailTransport;
  if (!nodemailer) return null;
  if (!SMTP_USER || !SMTP_PASS) return null;
  try {
    _mailTransport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    return _mailTransport;
  } catch (e) {
    console.error('Mailer init error:', e.message);
    return null;
  }
}

async function sendEmail({ to, subject, html, text }) {
  const t = getMailer();
  if (!t) {
    console.log(`📭 [email skipped — SMTP not configured] to=${to} subject="${subject}"`);
    return { skipped: true };
  }
  try {
    const info = await t.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      text: text || (html ? html.replace(/<[^>]+>/g, '') : ''),
      html,
    });
    console.log(`✉️  Email sent to ${to}: ${info.messageId}`);
    return { ok: true, id: info.messageId };
  } catch (e) {
    console.error(`Email send failed to ${to}:`, e.message);
    return { ok: false, error: e.message };
  }
}

// -- Reusable email HTML shell (KASIMOB gold style) --
function emailShell(title, bodyHtml) {
  return `
  <div style="font-family:'Poppins',Arial,sans-serif;background:#0a0a0a;padding:24px;color:#f5f5f5;">
    <div style="max-width:600px;margin:auto;background:linear-gradient(180deg,#1a1a1a 0%,#0a0a0a 100%);border:2px solid #d4af37;border-radius:12px;overflow:hidden;">
      <div style="background:#000;padding:22px;text-align:center;border-bottom:1px solid rgba(212,175,55,.3);">
        <div style="font-family:'Cinzel',Georgia,serif;letter-spacing:3px;font-size:26px;color:#d4af37;font-weight:800;">KASIMOB</div>
        <div style="color:#999;font-size:11px;letter-spacing:2px;margin-top:4px;">LUXURY • FASHION • LIFESTYLE</div>
      </div>
      <div style="padding:26px 24px;color:#eaeaea;line-height:1.6;font-size:14px;">
        <h2 style="color:#d4af37;margin:0 0 14px;font-family:'Cinzel',Georgia,serif;letter-spacing:1px;">${title}</h2>
        ${bodyHtml}
      </div>
      <div style="background:#000;padding:14px;text-align:center;color:#777;font-size:11px;letter-spacing:1px;border-top:1px solid rgba(212,175,55,.2);">
        Need help? Reply to this email or contact ${SHOP_EMAIL}<br>
        &copy; ${new Date().getFullYear()} KASIMOB. All rights reserved.
      </div>
    </div>
  </div>`;
}

function moneyKES(n) { return 'KSh ' + Number(n || 0).toLocaleString(); }

// -- Build a printable HTML receipt for an order --
function buildReceiptHTML(order) {
  let items = [];
  try { items = JSON.parse(order.items || '[]'); } catch {}
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;">${escapeHtml(i.name || '')}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;">${i.qty || 1}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right;">${moneyKES(i.price)}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right;">${moneyKES((i.price || 0) * (i.qty || 1))}</td>
    </tr>
  `).join('') || `<tr><td colspan="4" style="padding:12px;text-align:center;color:#888;">No items</td></tr>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Receipt ${escapeHtml(order.order_id)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;background:#f4f4f4;padding:20px;color:#222;}
  .wrap{max-width:720px;margin:auto;background:#fff;border-top:8px solid #d4af37;padding:32px;box-shadow:0 6px 24px rgba(0,0,0,.08);}
  h1{font-family:Georgia,serif;color:#b8941f;letter-spacing:2px;margin:0 0 4px;}
  .sub{color:#888;font-size:12px;letter-spacing:2px;margin-bottom:22px;}
  .grid{display:flex;flex-wrap:wrap;gap:20px;margin-bottom:22px;}
  .box{flex:1;min-width:220px;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:12px 14px;font-size:13px;}
  .box b{color:#b8941f;display:block;margin-bottom:4px;font-size:11px;letter-spacing:1px;}
  table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px;}
  th{background:#111;color:#d4af37;padding:10px 6px;text-align:left;font-size:12px;letter-spacing:1px;}
  .tot{margin-top:14px;text-align:right;font-size:15px;}
  .tot b{color:#b8941f;font-size:20px;}
  .paid{display:inline-block;padding:4px 10px;border-radius:20px;font-size:11px;letter-spacing:1px;background:#e8f7ee;color:#0a7a3d;border:1px solid #0a7a3d;}
  .foot{margin-top:26px;padding-top:14px;border-top:1px dashed #ddd;font-size:12px;color:#666;text-align:center;line-height:1.7;}
  .noprint{margin:0 auto 14px;max-width:720px;text-align:right;}
  .btn{display:inline-block;background:#d4af37;color:#000;padding:8px 16px;border-radius:6px;font-weight:700;text-decoration:none;}
  @media print { .noprint{display:none;} body{background:#fff;} }
</style></head>
<body>
  <div class="noprint"><a href="javascript:window.print()" class="btn">🖨️ Print / Save as PDF</a></div>
  <div class="wrap">
    <h1>KASIMOB</h1>
    <div class="sub">OFFICIAL RECEIPT &nbsp;•&nbsp; ${escapeHtml(order.order_id || '')}</div>

    <div class="grid">
      <div class="box">
        <b>BILLED TO</b>
        ${escapeHtml(order.name || '')}<br>
        ${escapeHtml(order.email || '')}<br>
        ${escapeHtml(order.phone || '')}<br>
        ${escapeHtml(order.location || '')}
      </div>
      <div class="box">
        <b>ORDER INFO</b>
        Order: ${escapeHtml(order.order_id || '')}<br>
        Date: ${new Date(order.created_at || Date.now()).toLocaleString()}<br>
        Status: <span class="paid">${escapeHtml(order.status || 'PENDING')}</span><br>
        Progress: ${escapeHtml(order.progress || 'Placed')}<br>
        ${order.mpesa_receipt ? 'M-Pesa Ref: <b>' + escapeHtml(order.mpesa_receipt) + '</b>' : ''}
      </div>
    </div>

    <table>
      <thead><tr><th>Item</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Price</th><th style="text-align:right;">Subtotal</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="tot">Total: <b>${moneyKES(order.amount)}</b></div>

    <div class="foot">
      Thank you for shopping with KASIMOB.<br>
      Questions? ${escapeHtml(SHOP_EMAIL)}<br>
      This is a computer-generated receipt.
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============ ROUTES ============
app.get('/', (req, res) => {
  res.json({ name: 'KASIMOB Backend', status: 'running', version: '1.3.0' });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Expose Google Client ID to the frontend (safe — it's public)
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || null,
    shopEmail: SHOP_EMAIL,
    emailEnabled: !!(SMTP_USER && SMTP_PASS && nodemailer),
  });
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

        // ---- Send WELCOME email (async, non-blocking) ----
        const displayName = name && name.trim() ? name.trim() : em.split('@')[0];
        const body = `
          <p>Hello <b>${escapeHtml(displayName)}</b>,</p>
          <p>Welcome to <b style="color:#d4af37;">KASIMOB</b> — where premium fashion meets golden deals. 🎉</p>
          <p>Your account has been created successfully. You can now:</p>
          <ul style="color:#ddd;">
            <li>Browse our latest luxury collections</li>
            <li>Enjoy exclusive member-only discounts</li>
            <li>Track every order in real time from your account</li>
            <li>Get instant email receipts when you check out</li>
          </ul>
          <p style="margin-top:18px;">Happy shopping! ✨</p>
          <p style="color:#999;font-size:12px;margin-top:20px;">If you didn't create this account, please ignore this email.</p>
        `;
        sendEmail({
          to: em,
          subject: '✨ Welcome to KASIMOB',
          html: emailShell('Welcome to KASIMOB 👑', body),
        }).catch(() => {});

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

// Forgot password — sends reset link via email
app.post('/api/auth/forgot', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  const em = String(email).trim().toLowerCase();

  // Always respond success to avoid leaking which emails exist.
  const respond = () => res.json({ success: true, message: 'If an account exists for this email, a reset link has been sent.' });

  db.get('SELECT id, email, name FROM users WHERE email = ?', [em], (err, user) => {
    if (err || !user) return respond();

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 60 minutes
    db.run(
      `INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)`,
      [user.id, token, expires],
      (e2) => {
        if (e2) return respond();
        const link = `${PUBLIC_BASE_URL}/reset-password?token=${token}`;
        const body = `
          <p>Hello <b>${escapeHtml(user.name || user.email)}</b>,</p>
          <p>We received a request to reset your KASIMOB password.
             Click the button below to set a new password. This link expires in <b>60 minutes</b>.</p>
          <p style="text-align:center;margin:22px 0;">
            <a href="${link}"
               style="display:inline-block;background:linear-gradient(135deg,#d4af37,#b8941f);color:#000;font-weight:700;padding:12px 26px;border-radius:6px;text-decoration:none;letter-spacing:1px;">
               RESET MY PASSWORD
            </a>
          </p>
          <p style="font-size:12px;color:#aaa;">If the button doesn't work, copy and paste this link:<br>
          <a href="${link}" style="color:#d4af37;">${link}</a></p>
          <p style="color:#999;font-size:12px;margin-top:18px;">If you didn't request this, you can safely ignore this email — your password will not change.</p>
        `;
        sendEmail({
          to: user.email,
          subject: '🔑 Reset your KASIMOB password',
          html: emailShell('Reset your password', body),
        }).catch(() => {});
        respond();
      }
    );
  });
});

// Verify token — used by the /reset-password page before showing the form
app.get('/api/auth/reset/verify', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ valid: false, error: 'Missing token.' });
  db.get(
    `SELECT pr.id, pr.expires_at, pr.used, u.email
       FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token = ?`, [token],
    (err, row) => {
      if (err || !row) return res.json({ valid: false, error: 'Invalid or expired link.' });
      if (row.used) return res.json({ valid: false, error: 'This link has already been used.' });
      if (new Date(row.expires_at) < new Date()) return res.json({ valid: false, error: 'This link has expired.' });
      res.json({ valid: true, email: row.email });
    }
  );
});

// Reset password — consumes token, updates password
app.post('/api/auth/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  db.get(
    `SELECT * FROM password_resets WHERE token = ?`, [token],
    (err, pr) => {
      if (err || !pr) return res.status(400).json({ error: 'Invalid or expired link.' });
      if (pr.used) return res.status(400).json({ error: 'This link has already been used.' });
      if (new Date(pr.expires_at) < new Date()) return res.status(400).json({ error: 'This link has expired.' });

      const { salt, hash } = hashPassword(password);
      db.run(
        `UPDATE users SET password_hash = ?, password_salt = ?, provider = COALESCE(provider,'local') WHERE id = ?`,
        [hash, salt, pr.user_id],
        (e2) => {
          if (e2) return res.status(500).json({ error: 'Could not update password.' });
          db.run(`UPDATE password_resets SET used = 1 WHERE id = ?`, [pr.id]);
          res.json({ success: true, message: 'Password updated. You can now sign in.' });
        }
      );
    }
  );
});

// Nice standalone reset-password page (served by backend so it also works on Render)
app.get('/reset-password', (req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
  <title>Reset Password • KASIMOB</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#0a0a0a;color:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
    .box{max-width:420px;width:100%;background:linear-gradient(180deg,#1a1a1a 0%,#0a0a0a 100%);border:2px solid #d4af37;border-radius:12px;padding:32px 28px;box-shadow:0 25px 80px rgba(212,175,55,.2);}
    h1{color:#d4af37;margin:0 0 4px;font-family:Georgia,serif;letter-spacing:2px;text-align:center;}
    .sub{color:#999;text-align:center;font-size:12px;letter-spacing:2px;margin-bottom:20px;}
    label{display:block;color:#d4af37;font-size:12px;margin:12px 0 6px;letter-spacing:.5px;}
    input{width:100%;padding:11px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(212,175,55,.3);color:#fff;border-radius:6px;outline:none;font-size:14px;box-sizing:border-box;}
    input:focus{border-color:#d4af37;}
    button{width:100%;margin-top:16px;background:linear-gradient(135deg,#d4af37,#b8941f);color:#000;font-weight:700;padding:12px;border:none;border-radius:6px;letter-spacing:1px;cursor:pointer;}
    .msg{text-align:center;margin-top:12px;font-size:13px;min-height:20px;}
    .msg.err{color:#e63946;} .msg.ok{color:#06d6a0;}
    a{color:#d4af37;}
  </style></head><body>
    <div class="box">
      <h1>KASIMOB</h1>
      <div class="sub">RESET YOUR PASSWORD</div>
      <div id="form">
        <div id="email" style="color:#ccc;font-size:13px;text-align:center;margin-bottom:12px;"></div>
        <label>New password (min 6 characters)</label>
        <input id="pw" type="password" minlength="6" placeholder="••••••••">
        <label>Confirm new password</label>
        <input id="pw2" type="password" minlength="6" placeholder="••••••••">
        <button id="btn">UPDATE PASSWORD</button>
        <div id="msg" class="msg"></div>
      </div>
    </div>
    <script>
      const params = new URLSearchParams(location.search);
      const token = params.get('token') || '';
      const msg = document.getElementById('msg');
      const emailBox = document.getElementById('email');
      const form = document.getElementById('form');

      async function verify(){
        if(!token){ form.innerHTML='<div class="msg err">Missing token in link.</div>'; return; }
        const r = await fetch('/api/auth/reset/verify?token='+encodeURIComponent(token));
        const d = await r.json();
        if(!d.valid){ form.innerHTML='<div class="msg err">'+(d.error||'Invalid link.')+'</div>'; return; }
        emailBox.textContent = 'Account: ' + d.email;
      }
      verify();

      document.getElementById('btn').onclick = async () => {
        msg.className='msg'; msg.textContent='';
        const pw = document.getElementById('pw').value;
        const pw2 = document.getElementById('pw2').value;
        if (pw.length < 6){ msg.className='msg err'; msg.textContent='Password must be at least 6 characters.'; return; }
        if (pw !== pw2){ msg.className='msg err'; msg.textContent='Passwords do not match.'; return; }
        const r = await fetch('/api/auth/reset', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password:pw})});
        const d = await r.json();
        if(r.ok && d.success){
          msg.className='msg ok'; msg.textContent='Password updated. You can close this tab and sign in.';
        } else {
          msg.className='msg err'; msg.textContent = d.error || 'Could not update password.';
        }
      };
    </script>
  </body></html>`);
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

      const finish = (u, isNew) => {
        req.session.userId    = u.id;
        req.session.userEmail = u.email;
        req.session.userName  = u.name || '';
        db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [u.id]);
        // Welcome email on first-time Google signup
        if (isNew) {
          const body = `
            <p>Hello <b>${escapeHtml(u.name || u.email)}</b>,</p>
            <p>Welcome to <b style="color:#d4af37;">KASIMOB</b>! Your account was created via Google sign-in. 🎉</p>
            <p>You're all set to shop premium fashion, watches, and lifestyle products. ✨</p>
          `;
          sendEmail({ to: u.email, subject: '✨ Welcome to KASIMOB', html: emailShell('Welcome to KASIMOB 👑', body) }).catch(()=>{});
        }
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
        finish(user, false);
      } else {
        db.run(
          `INSERT INTO users (email, name, google_id, picture, provider, last_login)
           VALUES (?, ?, ?, ?, 'google', CURRENT_TIMESTAMP)`,
          [email, name, googleId, picture],
          function (err2) {
            if (err2) return res.status(500).json({ error: 'Could not create account.' });
            finish({ id: this.lastID, email, name, picture }, true);
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

// STK Push — requires the shopper to be signed in
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
                          merchant_request_id, checkout_request_id, status, progress)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'Placed')
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

    // If PAID, roll customer aggregate + send receipt email
    if (status === 'PAID') {
      db.get('SELECT * FROM orders WHERE checkout_request_id = ?', [checkoutId], (err, row) => {
        if (!err && row) {
          upsertCustomerOnPaid(row.email, row.name, row.phone, row.location, row.amount);
          sendReceiptEmail(row).catch(() => {});
        }
      });
    }
  } catch (e) {
    console.error('Callback error:', e);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Build & send the receipt email for a paid order (idempotent)
async function sendReceiptEmail(order) {
  if (!order || !order.email) return;
  if (order.receipt_sent) return; // avoid double-sends
  const receiptLink = `${PUBLIC_BASE_URL}/api/receipt/${encodeURIComponent(order.order_id)}`;
  let items = [];
  try { items = JSON.parse(order.items || '[]'); } catch {}
  const itemsHtml = items.map(i => `
    <tr>
      <td style="padding:6px 4px;border-bottom:1px solid rgba(212,175,55,.15);">${escapeHtml(i.name || '')}</td>
      <td style="padding:6px 4px;border-bottom:1px solid rgba(212,175,55,.15);text-align:center;">${i.qty || 1}</td>
      <td style="padding:6px 4px;border-bottom:1px solid rgba(212,175,55,.15);text-align:right;color:#d4af37;">${moneyKES((i.price||0)*(i.qty||1))}</td>
    </tr>
  `).join('');
  const body = `
    <p>Hello <b>${escapeHtml(order.name || '')}</b>,</p>
    <p>Thank you for your order! Your payment has been received. Here's your receipt:</p>
    <div style="background:#000;border:1px solid rgba(212,175,55,.3);border-radius:8px;padding:14px;margin:12px 0;font-size:13px;">
      <div style="color:#999;font-size:11px;letter-spacing:1px;">ORDER</div>
      <div style="color:#d4af37;font-weight:700;font-size:16px;letter-spacing:1px;margin-bottom:10px;">${escapeHtml(order.order_id)}</div>
      ${order.mpesa_receipt ? `<div style="color:#ccc;">M-Pesa ref: <b style="color:#06d6a0;">${escapeHtml(order.mpesa_receipt)}</b></div>` : ''}
      <table style="width:100%;border-collapse:collapse;margin-top:10px;">
        <thead><tr><th style="text-align:left;color:#d4af37;font-size:11px;padding:6px 4px;border-bottom:1px solid rgba(212,175,55,.3);">Item</th>
        <th style="text-align:center;color:#d4af37;font-size:11px;padding:6px 4px;border-bottom:1px solid rgba(212,175,55,.3);">Qty</th>
        <th style="text-align:right;color:#d4af37;font-size:11px;padding:6px 4px;border-bottom:1px solid rgba(212,175,55,.3);">Subtotal</th></tr></thead>
        <tbody>${itemsHtml || '<tr><td colspan="3" style="padding:8px;color:#888;text-align:center;">No items</td></tr>'}</tbody>
      </table>
      <div style="text-align:right;margin-top:10px;color:#eee;">Total: <b style="color:#d4af37;font-size:18px;">${moneyKES(order.amount)}</b></div>
    </div>
    <p style="text-align:center;margin:20px 0;">
      <a href="${receiptLink}"
         style="display:inline-block;background:linear-gradient(135deg,#d4af37,#b8941f);color:#000;font-weight:700;padding:12px 26px;border-radius:6px;text-decoration:none;letter-spacing:1px;">
         📄 DOWNLOAD YOUR RECEIPT
      </a>
    </p>
    <p style="color:#aaa;font-size:12px;text-align:center;">
      Or open this link: <a href="${receiptLink}" style="color:#d4af37;">${receiptLink}</a>
    </p>
    <p style="margin-top:18px;">We'll email you again as your order progresses. You can also track it live in your account.</p>
  `;
  const r = await sendEmail({
    to: order.email,
    subject: `🧾 KASIMOB Receipt — ${order.order_id}`,
    html: emailShell('Payment received — thank you!', body),
  });
  if (r && r.ok) {
    db.run(`UPDATE orders SET receipt_sent = 1 WHERE order_id = ?`, [order.order_id]);
  }
}

// Public: download HTML receipt (works for PAID orders only)
app.get('/api/receipt/:orderId', (req, res) => {
  const orderId = String(req.params.orderId || '');
  db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId], (err, order) => {
    if (err || !order) return res.status(404).type('html').send('<h3 style="font-family:Arial;padding:40px;text-align:center;">Receipt not found</h3>');
    if (order.status !== 'PAID') {
      return res.status(402).type('html').send(`<h3 style="font-family:Arial;padding:40px;text-align:center;">Receipt not available yet — order status is <b>${escapeHtml(order.status)}</b>.</h3>`);
    }
    res.type('html').send(buildReceiptHTML(order));
  });
});

// Public: get order status/progress (used by "My Orders" on the frontend)
app.get('/api/order/:orderId/status', (req, res) => {
  const orderId = String(req.params.orderId || '');
  db.get(
    `SELECT order_id, name, email, amount, status, progress, mpesa_receipt, created_at, updated_at
       FROM orders WHERE order_id = ?`, [orderId],
    (err, row) => {
      if (err || !row) return res.status(404).json({ error: 'Order not found' });
      res.json({ order: row });
    }
  );
});

// Signed-in user's own orders
app.get('/api/my-orders', requireUser, (req, res) => {
  const email = (req.session.userEmail || '').toLowerCase();
  if (!email) return res.json({ orders: [] });
  db.all(
    `SELECT id, order_id, name, email, phone, location, amount, items, status, progress,
            mpesa_receipt, created_at, updated_at
       FROM orders WHERE LOWER(email) = ? ORDER BY datetime(created_at) DESC LIMIT 100`,
    [email],
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
    totalCustomers: 0, totalCarts: 0, totalUsers: 0,
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
            db.get('SELECT COUNT(*) AS c FROM users', (e6, r6) => {
              stats.totalUsers = r6?.c || 0;
              res.json(stats);
            });
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

// Update order progress (admin)
// Allowed values: Placed, Processing, Packed, Shipped, Out for Delivery, Delivered, Cancelled
app.post('/api/admin/orders/:id/progress', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const progress = String(req.body.progress || '').trim();
  const allowed = ['Placed', 'Processing', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled'];
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  if (!allowed.includes(progress)) return res.status(400).json({ error: 'Invalid progress value' });

  db.run(
    `UPDATE orders SET progress = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [progress, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      // Email customer about progress (non-blocking)
      db.get(`SELECT * FROM orders WHERE id = ?`, [id], (e2, row) => {
        if (row && row.email) {
          const body = `
            <p>Hello <b>${escapeHtml(row.name || '')}</b>,</p>
            <p>Your order <b style="color:#d4af37;">${escapeHtml(row.order_id)}</b> has a status update:</p>
            <div style="background:#000;border:1px solid rgba(212,175,55,.3);border-radius:8px;padding:14px;margin:12px 0;text-align:center;">
              <div style="color:#999;font-size:11px;letter-spacing:1px;">CURRENT PROGRESS</div>
              <div style="color:#d4af37;font-weight:700;font-size:20px;letter-spacing:1px;margin-top:4px;">${escapeHtml(progress).toUpperCase()}</div>
            </div>
            <p>You can track your order any time from your KASIMOB account.</p>
          `;
          sendEmail({
            to: row.email,
            subject: `📦 Order ${row.order_id} — ${progress}`,
            html: emailShell('Order update', body),
          }).catch(() => {});
        }
      });
      res.json({ success: true, changes: this.changes });
    }
  );
});

// Manually resend receipt (admin convenience)
app.post('/api/admin/orders/:id/resend-receipt', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  db.get(`SELECT * FROM orders WHERE id = ?`, [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Order not found' });
    if (row.status !== 'PAID') return res.status(400).json({ error: 'Order is not PAID yet.' });
    // reset receipt_sent so sendReceiptEmail will send
    db.run(`UPDATE orders SET receipt_sent = 0 WHERE id = ?`, [id], () => {
      sendReceiptEmail(row).then(() => res.json({ success: true })).catch(e => res.status(500).json({ error: e.message }));
    });
  });
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

// Registered users list (accounts that signed up / signed in)
app.get('/api/admin/users', requireAdmin, (req, res) => {
  db.all(
    `SELECT id, email, name, provider, picture, created_at, last_login
       FROM users ORDER BY datetime(created_at) DESC LIMIT 500`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ users: rows || [] });
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
  console.log(`   Email (SMTP):   ${SMTP_USER && SMTP_PASS ? 'ENABLED as ' + SMTP_USER : 'disabled (set SMTP_USER/SMTP_PASS)'}`);
});
