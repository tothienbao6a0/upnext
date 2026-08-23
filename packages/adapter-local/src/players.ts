import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface PlayerSpec {
  bin: string;
  /** Build the argv to play `target`, optionally starting partway in. */
  args(target: string, startAtMs: number): string[];
  /** Whether this player accepts a start offset at all. */
  canSeek: boolean;
  /** Whether this player can open http(s) URLs. */
  canStream: boolean;
}

/**
 * Two very different backends behind one adapter, which is the point.
 *
 * ffplay takes a start offset and streams over the network; afplay does
 * neither. The adapter reports the difference through its capabilities rather
 * than pretending both can do everything, so an agent that asks whether it can
 * seek gets a truthful answer for the machine it is actually running on.
 */
export const PLAYERS: Record<string, PlayerSpec> = {
  ffplay: {
    bin: 'ffplay',
    args: (target, startAtMs) => [
      '-nodisp',
      '-autoexit',
      '-loglevel',
      'error',
      ...(startAtMs > 0 ? ['-ss', (startAtMs / 1000).toFixed(3)] : []),
      target,
    ],
    canSeek: true,
    canStream: true,
  },
  afplay: {
    bin: 'afplay',
    args: (target) => [target],
    canSeek: false,
    canStream: false,
  },
};

export async function detectPlayer(preference: string[] = ['ffplay', 'afplay']): Promise<
  PlayerSpec | null
> {
  for (const name of preference) {
    const spec = PLAYERS[name];
    if (!spec) continue;
    if (await exists(spec.bin)) return spec;
  }
  return null;
}

async function exists(bin: string): Promise<boolean> {
  try {
    await run('which', [bin]);
    return true;
  } catch {
    return false;
  }
}

/** Duration in ms via ffprobe, or null when it is not installed. */
export async function probeDurationMs(target: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      target,
    ]);
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}
