import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const filePath = path.join(config.dataDir, config.namespace, 'connections.json');
let records = new Map();
let writeChain = Promise.resolve();

const nowIso = () => new Date().toISOString();

const clone = (value) => JSON.parse(JSON.stringify(value));

async function persist() {
  const payload = JSON.stringify([...records.values()], null, 2);
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, filePath);
}

function queuePersist() {
  writeChain = writeChain.then(persist, persist);
  return writeChain;
}

export async function initStore() {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
    records = new Map(
      (Array.isArray(data) ? data : [])
        .filter((item) => item?.waba_id)
        .map((item) => [String(item.waba_id), item]),
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[store] Could not read connections file, starting clean:', error.message);
    }
    records = new Map();
    await persist();
  }
}

export function listConnections() {
  return [...records.values()]
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map(clone);
}

export function getConnection(wabaId) {
  const item = records.get(String(wabaId));
  return item ? clone(item) : null;
}

export async function createConnection({ name, workspaceId = null }) {
  const wabaId = crypto.randomUUID();
  const timestamp = nowIso();
  const record = {
    _id: wabaId,
    waba_id: wabaId,
    workspace_id: workspaceId,
    name: name || `WhatsApp ${wabaId.slice(0, 8)}`,
    provider: 'baileys',
    waba_type: 'baileys',
    connection_status: 'connecting',
    status: 'connecting',
    phone_number: null,
    display_phone_number: null,
    last_error: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  records.set(wabaId, record);
  await queuePersist();
  return clone(record);
}

export async function updateConnection(wabaId, patch) {
  const id = String(wabaId);
  const current = records.get(id);
  if (!current) return null;
  const next = { ...current, ...patch, updated_at: nowIso() };
  records.set(id, next);
  await queuePersist();
  return clone(next);
}

export async function deleteConnection(wabaId) {
  const deleted = records.delete(String(wabaId));
  if (deleted) await queuePersist();
  return deleted;
}
