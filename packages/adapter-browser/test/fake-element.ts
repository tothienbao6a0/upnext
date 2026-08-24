import type { MediaElementLike } from '../src/element.js';

/**
 * A media element with no browser under it.
 *
 * The adapter only ever touches the handful of members `MediaElementLike`
 * names, which is what makes this possible — and is the reason that interface
 * is deliberately tiny rather than `HTMLMediaElement`.
 */
export class FakeMediaElement implements MediaElementLike {
  src = '';
  currentTime = 0;
  volume = 1;

  #duration = 0;
  #paused = true;
  #handlers = new Map<string, Set<() => void>>();

  /** Every call the adapter made, in order. */
  readonly calls: string[] = [];
  /** Set to make `play()` reject, the way a browser does when autoplay is blocked. */
  blockAutoplay = false;

  get duration(): number {
    return this.#duration;
  }

  get paused(): boolean {
    return this.#paused;
  }

  async play(): Promise<void> {
    this.calls.push('play');
    if (this.blockAutoplay) throw new Error('NotAllowedError: play() failed because the user did not interact');
    this.#paused = false;
    this.emit('play');
  }

  pause(): void {
    this.calls.push('pause');
    this.#paused = true;
    this.emit('pause');
  }

  load(): void {
    this.calls.push('load');
  }

  addEventListener(type: string, listener: () => void): void {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#handlers.get(type)?.delete(listener);
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.#handlers.values()) total += set.size;
    return total;
  }

  // -- driving it from a test ------------------------------------------------

  emit(type: string): void {
    for (const listener of [...(this.#handlers.get(type) ?? [])]) listener();
  }

  /** Metadata arrived: the element now knows how long the thing is. */
  setDuration(seconds: number): void {
    this.#duration = seconds;
    this.emit('loadedmetadata');
  }

  /** The playhead moved. */
  tick(seconds: number): void {
    this.currentTime = seconds;
    this.emit('timeupdate');
  }

  finish(): void {
    this.#paused = true;
    this.emit('ended');
  }

  fail(): void {
    this.emit('error');
  }
}
