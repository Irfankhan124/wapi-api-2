import path from 'node:path';
import 'dotenv/config';

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const namespace = String(process.env.INSTANCE_NAMESPACE || 'wapi-system-2')
  .trim()
  .replace(/[^a-zA-Z0-9._-]+/g, '-') || 'wapi-system-2';

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 5000),
  namespace,
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  sessionDir: path.resolve(process.env.SESSION_DIR || './sessions'),
  allowedOrigins: String(process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:3001,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  authMode: String(process.env.AUTH_MODE || 'none').toLowerCase(),
  apiKey: process.env.API_KEY || '',
  qrTtlMs: int(process.env.QR_TTL_MS, 55_000),
  qrWaitMs: int(process.env.QR_WAIT_MS, 12_000),
  reconnectDelayMs: int(process.env.RECONNECT_DELAY_MS, 4_000),
  maxReconnectDelayMs: int(process.env.MAX_RECONNECT_DELAY_MS, 60_000),
  sendDelayMs: int(process.env.SEND_DELAY_MS, 750),
  syncFullHistory: bool(process.env.SYNC_FULL_HISTORY, false),
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
});
