// server/index.js
import express from 'express';
import multer from 'multer';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, DB_PATH } from './db.js';
import { createApiTrustMiddleware } from './requestTrust.js';
import { importOrdersJson } from './import.js';
import {
  getSummary,
  getProducts,
  getProductById,
  getAlerts,
  ackAlert,
  getOrders,
  getOrderById,
} from './queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '25mb' }));
app.use('/api', createApiTrustMiddleware());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

// GET /api/health
app.get('/api/health', (req, res) => {
  const orders = db.prepare('SELECT COUNT(*) AS n FROM grocer_order').get().n;
  const products = db.prepare('SELECT COUNT(*) AS n FROM product').get().n;
  const observations = db.prepare('SELECT COUNT(*) AS n FROM price_observation').get().n;

  res.json({
    ok: true,
    version: '1.0.0',
    orders,
    products,
    observations,
    db_path: DB_PATH,
  });
});

// POST /api/import
app.post('/api/import', upload.single('file'), (req, res) => {
  try {
    let jsonContent;
    let filename = 'breadcrumbs-orders.json';

    if (req.file) {
      jsonContent = req.file.buffer.toString('utf8');
      filename = req.file.originalname || filename;
    } else if (req.body && (Array.isArray(req.body) || typeof req.body === 'object')) {
      jsonContent = req.body;
    } else {
      return res.status(400).json({ error: 'No JSON payload or file uploaded' });
    }

    const result = importOrdersJson(db, jsonContent, filename);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/summary
app.get('/api/summary', (req, res) => {
  res.json(getSummary(db));
});

// GET /api/products
app.get('/api/products', (req, res) => {
  res.json(getProducts(db, req.query));
});

// GET /api/products/:id
app.get('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const data = getProductById(db, id);
  if (!data) {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json(data);
});

// GET /api/alerts
app.get('/api/alerts', (req, res) => {
  res.json(getAlerts(db, req.query));
});

// POST /api/alerts/:id/ack
app.post('/api/alerts/:id/ack', (req, res) => {
  const id = Number(req.params.id);
  const success = ackAlert(db, id);
  if (!success) {
    return res.status(404).json({ error: 'Alert not found or already acknowledged' });
  }
  res.json({ ok: true, id });
});

// GET /api/orders
app.get('/api/orders', (req, res) => {
  res.json(getOrders(db));
});

// GET /api/orders/:id
app.get('/api/orders/:id', (req, res) => {
  const data = getOrderById(db, req.params.id);
  if (!data) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json(data);
});

// Serve static frontend assets and SPA fallback
const distDir = path.join(__dirname, '..', 'app', 'dist');
app.use(express.static(distDir));

app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const PORT = process.env.PORT || 8800;

export function parseBindAddresses(val = process.env.BREADCRUMBS_BIND_ADDRESSES) {
  const raw = val !== undefined && val !== null ? String(val) : '127.0.0.1,100.64.0.36';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function startServer(appInstance = app, port = PORT, addressesStr = process.env.BREADCRUMBS_BIND_ADDRESSES) {
  const addrs = parseBindAddresses(addressesStr);
  const servers = [];
  for (const addr of addrs) {
    const srv = http.createServer(appInstance);
    srv.on('error', (err) => {
      console.warn(`breadcrumbs-history warning: failed to bind to http://${addr}:${port} (${err.code || err.message})`);
    });
    srv.listen(port, addr, () => {
      console.log(`breadcrumbs-history server listening on http://${addr}:${port}`);
    });
    servers.push(srv);
  }
  return servers;
}

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export { app };
