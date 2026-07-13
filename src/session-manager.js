import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { config } from './config.js';
import {
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection,
} from './store.js';

const logger = pino({ level: config.nodeEnv === 'development' ? 'info' : 'warn' });
const sessions = new Map();
let io = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanId = (value) => String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
const sessionPath = (wabaId) => path.join(config.sessionDir, config.namespace, cleanId(wabaId));

function publicStatus(session, record = null) {
  const status = session?.status || record?.connection_status || record?.status || 'disconnected';
  return {
    waba_id: record?.waba_id || session?.wabaId || null,
    status,
    connection_status: status,
    phone_number: record?.phone_number || session?.phoneNumber || null,
    last_error: session?.lastError || record?.last_error || null,
  };
}

async function postWebhook(event, payload) {
  if (!config.webhookUrl) return;
  try {
    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.webhookSecret ? { 'x-wapi-signature': config.webhookSecret } : {}),
      },
      body: JSON.stringify({ event, namespace: config.namespace, payload, sent_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.warn('[webhook] Delivery failed:', error.message);
  }
}

function emit(event, payload) {
  io?.emit(event, payload);
  void postWebhook(event, payload);
}

export function setSocketServer(socketServer) {
  io = socketServer;
}

function getOrCreateRuntime(wabaId) {
  const id = String(wabaId);
  if (!sessions.has(id)) {
    sessions.set(id, {
      wabaId: id,
      sock: null,
      status: 'disconnected',
      qr: null,
      qrCreatedAt: 0,
      starting: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      stopped: false,
      restarting: false,
      lastError: null,
      phoneNumber: null,
      sendChain: Promise.resolve(),
    });
  }
  return sessions.get(id);
}

function extractDisconnectCode(lastDisconnect) {
  const error = lastDisconnect?.error;
  return error?.output?.statusCode || error?.statusCode || error?.data?.statusCode || null;
}

async function setStatus(runtime, status, patch = {}) {
  runtime.status = status;
  if ('lastError' in patch) runtime.lastError = patch.lastError;
  if ('phoneNumber' in patch) runtime.phoneNumber = patch.phoneNumber;

  const record = await updateConnection(runtime.wabaId, {
    connection_status: status,
    status,
    last_error: runtime.lastError || null,
    ...(runtime.phoneNumber
      ? { phone_number: runtime.phoneNumber, display_phone_number: runtime.phoneNumber }
      : {}),
  });
  emit('whatsapp:status', publicStatus(runtime, record));
}

async function scheduleReconnect(runtime) {
  if (runtime.stopped || runtime.reconnectTimer) return;
  runtime.reconnectAttempts += 1;
  const delay = Math.min(
    config.reconnectDelayMs * Math.max(1, 2 ** (runtime.reconnectAttempts - 1)),
    config.maxReconnectDelayMs,
  );
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null;
    void startSession(runtime.wabaId, { force: true }).catch((error) => {
      console.error(`[${runtime.wabaId}] reconnect failed:`, error.message);
    });
  }, delay);
  runtime.reconnectTimer.unref?.();
}

export async function startSession(wabaId, { force = false } = {}) {
  const record = getConnection(wabaId);
  if (!record) throw new Error('Connection not found');

  const runtime = getOrCreateRuntime(wabaId);
  runtime.stopped = false;

  if (runtime.starting) return runtime.starting;
  if (!force && runtime.sock && ['connecting', 'qr_ready', 'connected'].includes(runtime.status)) {
    return runtime;
  }

  runtime.starting = (async () => {
    const previousStatus = runtime.status;
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }

    try {
      runtime.restarting = true;
      try {
        runtime.sock?.end?.(new Error('Session restart'));
      } catch {}
      runtime.sock = null;
      runtime.qr = null;
      runtime.qrCreatedAt = 0;
      runtime.lastError = null;
      await setStatus(runtime, 'connecting', { lastError: null });

      const authDir = sessionPath(wabaId);
      if (force && previousStatus === 'logged_out') {
        await fs.rm(authDir, { recursive: true, force: true });
      }
      await fs.mkdir(authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      let version;
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
      } catch (error) {
        console.warn('[baileys] Could not fetch latest WA version; using library default:', error.message);
      }

      const socket = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger,
        browser: Browsers.ubuntu('WAPI'),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: config.syncFullHistory,
        generateHighQualityLinkPreview: true,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 20_000,
        getMessage: async () => undefined,
      });

      runtime.sock = socket;
      runtime.restarting = false;

      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('connection.update', async (update) => {
        try {
          const { connection, lastDisconnect, qr } = update;
          if (qr) {
            runtime.qr = qr;
            runtime.qrCreatedAt = Date.now();
            await setStatus(runtime, 'qr_ready', { lastError: null });
            const qrCode = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
            emit('whatsapp:qr', { waba_id: runtime.wabaId, status: 'qr_ready', qr_code: qrCode });
          }

          if (connection === 'open') {
            runtime.qr = null;
            runtime.qrCreatedAt = 0;
            runtime.reconnectAttempts = 0;
            const phoneNumber = String(socket.user?.id || '').split(':')[0].split('@')[0] || null;
            await setStatus(runtime, 'connected', { phoneNumber, lastError: null });
          }

          if (connection === 'close') {
            if (runtime.restarting) return;
            runtime.sock = null;
            const code = extractDisconnectCode(lastDisconnect);
            const loggedOut = code === DisconnectReason.loggedOut || code === 401;
            const reason = lastDisconnect?.error?.message || `WhatsApp disconnected${code ? ` (${code})` : ''}`;

            if (runtime.stopped) {
              await setStatus(runtime, 'disconnected', { lastError: null });
            } else if (loggedOut) {
              await setStatus(runtime, 'logged_out', { lastError: reason });
            } else {
              await setStatus(runtime, 'reconnecting', { lastError: reason });
              await scheduleReconnect(runtime);
            }
          }
        } catch (error) {
          console.error(`[${runtime.wabaId}] connection.update error:`, error);
        }
      });

      socket.ev.on('messages.upsert', ({ messages, type }) => {
        for (const message of messages || []) {
          if (!message?.key?.remoteJid || message.key.remoteJid === 'status@broadcast') continue;
          emit('whatsapp:message', {
            waba_id: runtime.wabaId,
            type,
            key: message.key,
            pushName: message.pushName || null,
            message: message.message || null,
            received_at: new Date().toISOString(),
          });
        }
      });

      return runtime;
    } catch (error) {
      runtime.restarting = false;
      runtime.sock = null;
      runtime.lastError = error.message;
      await setStatus(runtime, 'failed', { lastError: error.message });
      throw error;
    } finally {
      runtime.starting = null;
    }
  })();

  return runtime.starting;
}

export async function getQrResponse(wabaId) {
  const runtime = getOrCreateRuntime(wabaId);
  const record = getConnection(wabaId);
  if (!record) throw new Error('Connection not found');

  if (runtime.qr && Date.now() - runtime.qrCreatedAt > config.qrTtlMs) {
    runtime.qr = null;
    runtime.qrCreatedAt = 0;
    void startSession(wabaId, { force: true });
  } else if (!runtime.sock && !runtime.starting) {
    void startSession(wabaId, { force: runtime.status === 'logged_out' || runtime.status === 'failed' });
  }

  const deadline = Date.now() + config.qrWaitMs;
  while (Date.now() < deadline) {
    if (runtime.status === 'connected') {
      return { qr_code: null, status: 'connected' };
    }
    if (runtime.qr) {
      return {
        qr_code: await QRCode.toDataURL(runtime.qr, { margin: 1, width: 320 }),
        status: 'qr_ready',
      };
    }
    if (['failed', 'logged_out'].includes(runtime.status) && !runtime.starting) break;
    await sleep(250);
  }

  return {
    qr_code: null,
    status: runtime.status === 'qr_ready' ? 'qr_timeout' : runtime.status,
    error: runtime.lastError || null,
  };
}

export function getSessionStatus(wabaId) {
  return publicStatus(sessions.get(String(wabaId)), getConnection(wabaId));
}

export async function sendText({ wabaId, phone, text }) {
  const runtime = getOrCreateRuntime(wabaId);
  if (runtime.status !== 'connected' || !runtime.sock) {
    await startSession(wabaId);
  }
  if (runtime.status !== 'connected' || !runtime.sock) {
    throw new Error(`WhatsApp connection is not ready (status: ${runtime.status})`);
  }

  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) {
    throw new Error('Phone number must contain 6 to 15 digits including country code');
  }
  const messageText = String(text || '').trim();
  if (!messageText) throw new Error('Message text is required');

  const task = async () => {
    const jid = `${digits}@s.whatsapp.net`;
    const availability = await runtime.sock.onWhatsApp(jid);
    if (Array.isArray(availability) && availability.length === 0) {
      throw new Error('This phone number is not registered on WhatsApp');
    }
    const result = await runtime.sock.sendMessage(jid, { text: messageText });
    if (config.sendDelayMs > 0) await sleep(config.sendDelayMs);
    return {
      id: result?.key?.id || null,
      key: result?.key || null,
      jid,
      phone: digits,
      status: 'sent',
    };
  };

  runtime.sendChain = runtime.sendChain.then(task, task);
  return runtime.sendChain;
}

export async function stopSession(wabaId, { logout = false } = {}) {
  const runtime = getOrCreateRuntime(wabaId);
  runtime.stopped = true;
  runtime.qr = null;
  runtime.qrCreatedAt = 0;
  if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
  runtime.reconnectTimer = null;

  try {
    if (logout && runtime.sock) await runtime.sock.logout();
    else runtime.sock?.end?.(new Error('Disconnected by API'));
  } catch (error) {
    console.warn(`[${wabaId}] disconnect warning:`, error.message);
  }
  runtime.sock = null;

  if (logout) {
    await fs.rm(sessionPath(wabaId), { recursive: true, force: true });
    await setStatus(runtime, 'logged_out', { lastError: null, phoneNumber: null });
  } else {
    await setStatus(runtime, 'disconnected', { lastError: null });
  }
  return getSessionStatus(wabaId);
}

export async function removeSession(wabaId) {
  await stopSession(wabaId, { logout: true });
  sessions.delete(String(wabaId));
  await deleteConnection(wabaId);
}

export async function initializeSavedSessions() {
  for (const record of listConnections()) {
    const credsPath = path.join(sessionPath(record.waba_id), 'creds.json');
    try {
      await fs.access(credsPath);
      void startSession(record.waba_id).catch((error) => {
        console.warn(`[${record.waba_id}] auto-start failed:`, error.message);
      });
    } catch {
      await updateConnection(record.waba_id, {
        status: 'disconnected',
        connection_status: 'disconnected',
      });
    }
  }
}
