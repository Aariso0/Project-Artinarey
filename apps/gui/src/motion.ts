import { useReducedMotion } from 'motion/react';
import type { Transition } from 'motion/react';

/**
 * Springs start from the value currently on screen, so a new target can arrive
 * mid-flight without a jump. Critically damped by default; a little bounce is
 * reserved for interactions that carried real momentum (a flick or a drag).
 */
export const SPRING = { type: 'spring', bounce: 0, duration: 0.35 } as const;
export const FLICK_SPRING = { type: 'spring', bounce: 0.22, duration: 0.4 } as const;
export const QUICK = { duration: 0.16, ease: [0.16, 1, 0.3, 1] } as const;

export type MotionKind = 'spring' | 'flick' | 'quick';

/** Reduced motion keeps the state change legible but removes spatial travel. */
export function useMotionTransition(kind: MotionKind = 'spring'): Transition {
  const reduced = useReducedMotion() ?? false;
  if (reduced) return { duration: 0.12, ease: 'easeOut' };
  if (kind === 'flick') return FLICK_SPRING;
  if (kind === 'quick') return QUICK;
  return SPRING;
}

export function useMotionEnabled(): boolean {
  return !(useReducedMotion() ?? false);
}
