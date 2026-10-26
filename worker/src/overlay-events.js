import { normalizeOverlayEvent } from '../../overlay/event-core.js';

const MAX_EVENTS = 300;
const ID_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/;

// Events are separate from the existing gift lottery queue.
export async function processOverlayEvent(db, envName, fields, receivedAt = Date.now()) {
  const event = normalizeOverlayEvent(fields);
  if (!event || event.type === 'gift') return { status: 'skipped' };
  // Public Firebase readers must not receive TikTok usernames or raw comments.
  // Identity-free notifications are safer until authenticated Firebase reads exist.
  const id = String(fields.eventId || fields.msgId || '').trim();
  let dedupePath = null;
  if (VALID_ID.test(id)) {
    dedupePath = 'envs/' + envName + '/overlay/dedupe/' + event.type + '_' + id;
    const { value, etag } = await db.getWithEtag(dedupePath);
    if (value && receivedAt - Number(value) < ID_TTL_MS) return { status: 'duplicate' };
    if (!(await db.putIfMatch(dedupePath, receivedAt, etag))) return { status: 'duplicate' };
  }
  try {
    const payload = { type: event.type, count: event.count, timestamp: receivedAt };
    const result = await db.post('envs/' + envName + '/overlay/events', payload);
    return { status: 'queued', key: result.name, type: event.type };
  } catch (error) {
    if (dedupePath) await db.remove(dedupePath).catch(() => {});
    throw error;
  }
}

export async function cleanupOverlayEvents(db, envName, now = Date.now()) {
  const base = 'envs/' + envName + '/overlay';
  const trim = async (path, keep) => {
    const keys = Object.keys((await db.get(path, { shallow: 'true' })) || {}).sort();
    if (keys.length <= keep) return;
    const patch = {};
    for (const key of keys.slice(0, keys.length - keep)) patch[key] = null;
    await db.patch(path, patch);
  };
  await trim(base + '/events', MAX_EVENTS);
  const ids = (await db.get(base + '/dedupe')) || {};
  const expired = {};
  for (const [id, at] of Object.entries(ids)) if (now - Number(at) > ID_TTL_MS) expired[id] = null;
  if (Object.keys(expired).length) await db.patch(base + '/dedupe', expired);
}
