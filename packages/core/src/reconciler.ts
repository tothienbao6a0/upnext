import type { Binding, DesyncPolicy, MediaRef } from './types/index.js';

export type ReconcileAction = 'none' | 'adopted' | 'corrected' | 'ignored';

export interface ReconcilePlan {
  action: ReconcileAction;
  /** Present when `action` is `adopted`: what the backend is actually playing. */
  adopt?: Binding;
  /** Present when `action` is `corrected`: what to force it back to. */
  restore?: Binding;
}

/**
 * Decide who wins when a human moves an external player out from under us.
 *
 * The default is that the human does. An agent-owned queue that fights the
 * person holding the keyboard is a bug, not a feature — so `adopt` folds their
 * choice into the queue and carries on from there.
 *
 * Pure by design: the runtime applies the plan, this only chooses it.
 */
export function planReconciliation(
  policy: DesyncPolicy,
  current: Binding,
  actualUri: string | null,
  actualRef?: MediaRef,
): ReconcilePlan {
  // A backend reporting nothing is idle or between tracks, not hijacked.
  if (actualUri === null || actualUri === current.nativeUri) return { action: 'none' };

  switch (policy) {
    case 'ignore':
      return { action: 'ignored' };
    case 'correct':
      return { action: 'corrected', restore: current };
    case 'adopt':
      return {
        action: 'adopted',
        adopt: {
          adapterId: current.adapterId,
          nativeUri: actualUri,
          ref: actualRef ?? { uri: actualUri },
        },
      };
  }
}
