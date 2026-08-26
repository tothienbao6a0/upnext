export { AppleMusicAdapter } from './adapter.js';
export type { AppleMusicAdapterOptions } from './adapter.js';

export { parseState, parseSearchResults, hasEnded, trackUri, persistentIdFrom } from './parse.js';
export type { MusicReading } from './parse.js';

export { isInstalled, runAppleScript } from './applescript.js';
export type { ScriptRunner } from './applescript.js';
