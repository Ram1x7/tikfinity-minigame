import { normalizeOverlayEvent } from '../../overlay/event-core.js';

// Dedicated event pipeline. No lottery queue writes.
export async function processOverlayEvent(db, envName, fields, receivedAt = Date.now()) {
  const event = normalizeOverlayEvent(fields);
  if (!event || event.type === 'gift') return { status: 'skipped' };
  const payload = { ...event, timestamp: receivedAt };
  const result = await db.post('envs/' + envName + '/overlay/events', payload);
  return { status: 'queued', key: result.name };
}
