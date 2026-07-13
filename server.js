import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './src/config.js';
import {
  createConnection,
  getConnection,
  initStore,
  listConnections,
  updateConnection,
} from './src/store.js';
import {
  getQrResponse,
  getSessionStatus,
  initializeSavedSessions,
  removeSession,
  sendText,
  setSocketServer,
  startSession,
  stopSession,
} from './src/session-manager.js';

await initStore();

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

const corsOrigin = (origin, callback) => {
  if (!origin || config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin)) {
    return callback(null, true);
  }
  return callback(new Error(`CORS blocked origin: ${origin}`));
};

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use('/api', (req, res, next) => {
  if (config.authMode !== 'api-key') return next();
  const authorization = req.get('authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const supplied = req.get('x-api-key') || bearer;
  if (!config.apiKey || supplied !== config.apiKey) {
    return res.status(401).json({ success: false, message: 'Invalid or missing API key' });
  }
  next();
});

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const pickWabaId = (body = {}, query = {}) =>
  body.waba_id || body.wabaId || body.connection_id || body.connectionId || query.waba_id || query.wabaId || query.connection_id || query.connectionId;

const connectionView = (record) => ({
  ...record,
  ...getSessionStatus(record.waba_id),
});

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'WAPI API 2 fixed is running',
    namespace: config.namespace,
    version: '2.1.0',
  });
});

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok', uptime: process.uptime(), namespace: config.namespace });
});

app.get('/api/workspaces', (req, res) => {
  res.json({ success: true, data: listConnections().map(connectionView) });
});

app.get('/api/whatsapp/connections', (req, res) => {
  res.json({ success: true, data: listConnections().map(connectionView) });
});

app.get('/api/whatsapp/waba-list', (req, res) => {
  res.json({ success: true, data: listConnections().map(connectionView) });
});

app.post('/api/whatsapp/connect', asyncRoute(async (req, res) => {
  const provider = String(req.body.provider || 'baileys').toLowerCase();
  if (!['baileys', 'bailey'].includes(provider)) {
    return res.status(400).json({ success: false, message: 'This fixed package supports provider: baileys' });
  }

  const name = String(req.body.name || req.body.instance_name || '').trim();
  if (!name) return res.status(400).json({ success: false, message: 'Connection name is required' });

  const record = await createConnection({ name, workspaceId: req.body.workspace_id || null });
  await startSession(record.waba_id);
  res.status(201).json({ success: true, message: 'WhatsApp connection created', data: connectionView(record) });
}));

app.get('/api/whatsapp/baileys/qrcode/:wabaId', asyncRoute(async (req, res) => {
  const record = getConnection(req.params.wabaId);
  if (!record) return res.status(404).json({ success: false, message: 'WABA connection not found' });
  const data = await getQrResponse(req.params.wabaId);
  res.json({ success: true, data: { success: true, ...data } });
}));

app.get('/api/whatsapp/status', (req, res) => {
  const wabaId = pickWabaId({}, req.query) || listConnections()[0]?.waba_id;
  if (!wabaId || !getConnection(wabaId)) {
    return res.status(404).json({ success: false, message: 'Connection not found' });
  }
  res.json({ success: true, data: getSessionStatus(wabaId) });
});

app.post('/api/whatsapp/send', asyncRoute(async (req, res) => {
  const wabaId = pickWabaId(req.body, req.query) || listConnections().find((item) => getSessionStatus(item.waba_id).status === 'connected')?.waba_id;
  const phone = req.body.contact_no || req.body.phone || req.body.to || req.body.recipient || req.body.contact_number;
  const text = req.body.messageText || req.body.message || req.body.text || req.body.body;

  if (!wabaId) return res.status(400).json({ success: false, message: 'waba_id or connection_id is required' });
  if (!getConnection(wabaId)) return res.status(404).json({ success: false, message: 'Connection not found' });

  const result = await sendText({ wabaId, phone, text });
  res.json({ success: true, message: 'Message sent', data: result, message_id: result.id });
}));

app.post('/api/messages/send', asyncRoute(async (req, res) => {
  const wabaId = pickWabaId(req.body, req.query) || listConnections().find((item) => getSessionStatus(item.waba_id).status === 'connected')?.waba_id;
  const result = await sendText({
    wabaId,
    phone: req.body.to || req.body.phone || req.body.contact_no,
    text: req.body.text || req.body.message,
  });
  res.json({ success: true, data: result, message_id: result.id });
}));

app.post('/api/whatsapp/disconnect', asyncRoute(async (req, res) => {
  const wabaId = pickWabaId(req.body, req.query);
  if (!wabaId || !getConnection(wabaId)) return res.status(404).json({ success: false, message: 'Connection not found' });
  const data = await stopSession(wabaId, { logout: Boolean(req.body.logout) });
  res.json({ success: true, message: 'WhatsApp disconnected', data });
}));

app.post('/api/whatsapp/delete', asyncRoute(async (req, res) => {
  const ids = req.body.ids || req.body.waba_ids || [pickWabaId(req.body, req.query)];
  const cleanIds = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  for (const id of cleanIds) {
    if (getConnection(id)) await removeSession(id);
  }
  res.json({ success: true, message: 'Connection(s) deleted', data: cleanIds });
}));

app.put('/api/whatsapp/connect/:id', asyncRoute(async (req, res) => {
  const existing = getConnection(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Connection not found' });
  const updated = await updateConnection(req.params.id, {
    ...(req.body.name ? { name: String(req.body.name).trim() } : {}),
    ...(req.body.workspace_id !== undefined ? { workspace_id: req.body.workspace_id } : {}),
  });
  res.json({ success: true, data: connectionView(updated) });
}));

app.get('/api/whatsapp/phone-numbers', (req, res) => {
  const data = listConnections()
    .map(connectionView)
    .filter((item) => item.phone_number)
    .map((item) => ({
      _id: item.waba_id,
      waba_id: item.waba_id,
      phone_number_id: item.waba_id,
      display_phone_number: item.phone_number,
      verified_name: item.name,
      is_primary: true,
      status: item.status,
    }));
  res.json({ success: true, data });
});

app.get('/api/whatsapp/:wabaId/phone-numbers', (req, res) => {
  const item = getConnection(req.params.wabaId);
  if (!item) return res.status(404).json({ success: false, message: 'Connection not found' });
  const view = connectionView(item);
  const data = view.phone_number ? [{
    _id: view.waba_id,
    waba_id: view.waba_id,
    phone_number_id: view.waba_id,
    display_phone_number: view.phone_number,
    verified_name: view.name,
    is_primary: true,
    status: view.status,
  }] : [];
  res.json({ success: true, data });
});

app.use((error, req, res, next) => {
  console.error(`[${req.method} ${req.originalUrl}]`, error);
  if (res.headersSent) return next(error);
  const status = error?.message === 'Connection not found' ? 404 : 500;
  res.status(status).json({
    success: false,
    message: error?.message || 'Internal server error',
    ...(config.nodeEnv === 'development' ? { stack: error?.stack } : {}),
  });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  path: '/socket.io',
  cors: { origin: corsOrigin, credentials: true },
});
setSocketServer(io);

io.on('connection', (socket) => {
  socket.emit('wapi:ready', { namespace: config.namespace, version: '2.1.0' });
});

server.listen(config.port, () => {
  console.log(`WAPI API 2 fixed running on port ${config.port}`);
  console.log(`Instance namespace: ${config.namespace}`);
  void initializeSavedSessions();
});

const shutdown = async (signal) => {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
