// server.js
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const Razorpay = require('razorpay');

const {
  DATA_DIR = './data',
  PORT = 3000,
  JWT_SECRET = 'change_this_to_a_random_string',
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  PAYMENT_LINK = 'https://rzp.io/rzp/M31vi4u'
} = process.env;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOADS = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

const dbFile = path.join(DATA_DIR, 'data.db');
const db = new Database(dbFile);

// Init tables
db.prepare(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  password_hash TEXT,
  admin INTEGER DEFAULT 0,
  premium_until INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  artist TEXT,
  filename TEXT,
  rights TEXT,
  uploader_id INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now'))
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  provider TEXT,
  provider_order_id TEXT,
  provider_payment_id TEXT,
  amount INTEGER,
  currency TEXT,
  status TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
)`).run();

// Create admin if env provided and not exists
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL);
  if (!exists) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    db.prepare('INSERT INTO users (email,password_hash,admin) VALUES (?,?,1)').run(ADMIN_EMAIL, hash);
    console.log('Admin created:', ADMIN_EMAIL);
  }
}

const app = express();
app.use(express.json());
app.use(express.static('public')); // serve frontend from public/

// Razorpay client (optional)
let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
  console.log('Razorpay configured');
} else {
  console.log('Razorpay NOT configured — using PAYMENT_LINK fallback:', PAYMENT_LINK);
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, admin: !!user.admin }, JWT_SECRET, { expiresIn: '30d' });
}

function getAuthToken(req) {
  const a = req.headers.authorization;
  if (a && a.startsWith('Bearer ')) return a.split(' ')[1];
  if (req.query && req.query.t) return req.query.t;
  return '';
}

function authMiddleware(req, res, next) {
  const token = getAuthToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const u = db.prepare('SELECT id,email,admin,premium_until FROM users WHERE id = ?').get(payload.id);
    if (!u) return res.status(401).json({ error: 'Invalid user' });
    req.user = u;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Signup / login
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email+password required' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(400).json({ error: 'User exists' });
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare('INSERT INTO users (email,password_hash) VALUES (?,?)').run(email, hash);
  const user = db.prepare('SELECT id,email,admin,premium_until FROM users WHERE id = ?').get(info.lastInsertRowid);
  return res.json({ token: signToken(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u) return res.status(400).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
  const user = { id: u.id, email: u.email, admin: u.admin, premium_until: u.premium_until };
  return res.json({ token: signToken(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const premium = req.user.premium_until && req.user.premium_until > now;
  res.json({ email: req.user.email, admin: !!req.user.admin, premium });
});

// List songs
app.get('/api/songs', async (req, res) => {
  const rows = db.prepare('SELECT id,title,artist FROM songs ORDER BY created_at DESC').all();
  res.json(rows);
});

// Upload (admin only)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp3';
    const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/songs', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.user.admin) return res.status(403).json({ error: 'Only admin can upload' });
  const { title, artist, rights } = req.body;
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const info = db.prepare('INSERT INTO songs (title,artist,filename,rights,uploader_id) VALUES (?,?,?,?,?)')
    .run(title || req.file.originalname, artist || '', req.file.filename, rights || '', req.user.id);
  res.json({ id: info.lastInsertRowid });
});

// Stream endpoint with Range support. Accepts token in Authorization header or ?t=
app.get('/api/stream/:id', async (req, res) => {
  const id = req.params.id;
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  if (!song) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(UPLOADS, song.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
  if (isNaN(start) || isNaN(end) || start >= stat.size || end >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': (end - start) + 1,
    'Content-Type': 'audio/mpeg'
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

// Download — only for premium
app.get('/api/download/:id', authMiddleware, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  if (!req.user.premium_until || req.user.premium_until < now) return res.status(403).json({ error: 'Premium required' });

  const id = req.params.id;
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  if (!song) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(UPLOADS, song.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  res.download(filePath, `${song.title || 'song'}.mp3`);
});

// Return the payment link (fallback or explicit)
app.get('/api/pay/link', authMiddleware, (req, res) => {
  return res.json({ link: PAYMENT_LINK });
});

// Optional: direct redirect endpoint (no auth)
app.get('/pay', (req, res) => {
  return res.redirect(PAYMENT_LINK);
});

// Payment: create order or return link when Razorpay not configured
app.post('/api/pay/order', authMiddleware, async (req, res) => {
  // If razorpay configured → create order as before
  if (razorpay) {
    try {
      const amountRs = 59; // ₹59 per year
      const amountPaise = amountRs * 100;
      const order = await razorpay.orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt: `rcpt_${req.user.id}_${Date.now()}`,
        notes: { user_id: req.user.id + '' }
      });
      // store the pending payment
      db.prepare('INSERT INTO payments (user_id,provider,provider_order_id,amount,currency,status) VALUES (?,?,?,?,?,?)')
        .run(req.user.id, 'razorpay', order.id, amountPaise, 'INR', 'created');

      return res.json({ order, key: RAZORPAY_KEY_ID, email: req.user.email });
    } catch (e) {
      console.error('razorpay order error', e);
      return res.status(500).json({ error: 'Payment order creation failed' });
    }
  }

  // Fallback: return payment link
  return res.json({ link: PAYMENT_LINK });
});

// Payment: verify (only works when Razorpay configured)
app.post('/api/pay/verify', authMiddleware, express.json(), async (req, res) => {
  if (!razorpay) return res.status(400).json({ error: 'Razorpay not configured; no server-side verify available for link payments' });

  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {};
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) return res.status(400).json({ error: 'Missing fields' });

  // verify signature
  const shasum = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(razorpay_order_id + "|" + razorpay_payment_id).digest('hex');
  if (shasum !== razorpay_signature) return res.status(400).json({ error: 'Invalid signature' });

  // mark payment complete
  db.prepare('UPDATE payments SET provider_payment_id = ?, status = ? WHERE provider_order_id = ?')
    .run(razorpay_payment_id, 'paid', razorpay_order_id);

  // grant premium for 365 days
  const now = Math.floor(Date.now() / 1000);
  const oneYear = now + 365 * 24 * 3600;
  db.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(oneYear, req.user.id);

  res.json({ ok: true, premium_until: oneYear });
});

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
