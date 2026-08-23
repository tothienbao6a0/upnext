import { UpNextError, ErrorCodes } from './errors.js';
import type { Adapter } from './types/index.js';

/**
 * Check that an adapter can honour what it claims.
 *
 * Capabilities are promises about behaviour, and most of them are only
 * deliverable through a specific optional method. An adapter declaring
 * `endOfTrack: 'event'` without a `subscribe` does not crash — it just never
 * tells anyone a track finished, so the queue stops after the first item and
 * the author is left staring at a runtime that appears to work.
 *
 * Registration is the last moment this is cheap to catch, so it is caught here,
 * all problems at once, with the fix in the message.
 */
export function validateAdapter(adapter: Adapter): void {
  const problems: string[] = [];

  if (!adapter.id || typeof adapter.id !== 'string') {
    problems.push('`id` must be a non-empty string');
  }
  for (const method of ['match', 'resolve', 'load', 'play', 'stop'] as const) {
    if (typeof adapter[method] !== 'function') problems.push(`\`${method}\` is required`);
  }

  const caps = adapter.capabilities;
  if (!caps) {
    throw new UpNextError(
      ErrorCodes.AdapterFailed,
      `adapter ${adapter.id}: \`capabilities\` is required`,
      adapter.id,
    );
  }

  if (caps.endOfTrack === 'event' && !adapter.subscribe) {
    problems.push("declares endOfTrack 'event' but has no `subscribe`, so nothing would ever advance");
  }
  if (caps.endOfTrack === 'poll' && !adapter.poll) {
    problems.push("declares endOfTrack 'poll' but has no `poll`, so nothing would ever advance");
  }
  if (caps.position === 'authoritative' && !adapter.poll && !adapter.subscribe) {
    problems.push(
      "declares position 'authoritative' but has neither `poll` nor `subscribe`, so no position could ever arrive",
    );
  }
  if (caps.externalControl && !adapter.poll && !adapter.subscribe) {
    problems.push(
      'declares externalControl but has neither `poll` nor `subscribe`, so a takeover could never be detected',
    );
  }

  const gated: Array<[keyof typeof caps, keyof Adapter]> = [
    ['pause', 'pause'],
    ['seek', 'seek'],
    ['volume', 'setVolume'],
    ['search', 'search'],
  ];
  for (const [capability, method] of gated) {
    if (caps[capability] && typeof adapter[method] !== 'function') {
      problems.push(`declares ${String(capability)} but has no \`${String(method)}\``);
    }
  }

  if (problems.length > 0) {
    throw new UpNextError(
      ErrorCodes.AdapterFailed,
      `adapter ${adapter.id} is inconsistent:\n  - ${problems.join('\n  - ')}`,
      adapter.id,
    );
  }
}
