/**
 * Monotonic, human-legible, collision-free-within-a-process ids.
 *
 * Deliberately not UUIDs: these show up in agent transcripts and CLI output,
 * where `q_0007` is far easier for a model or a person to copy correctly than
 * a 36-character hex string. Uniqueness only has to hold within one runtime.
 */
export function createIdFactory(prefix = 'q', start = 0): () => string {
  let n = start;
  return () => `${prefix}_${(++n).toString().padStart(4, '0')}`;
}
