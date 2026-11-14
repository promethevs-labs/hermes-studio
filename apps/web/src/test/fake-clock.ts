import { vi } from "vitest";

/**
 * Removes vitest's fake clock without leaving jsdom's rendering interval on it.
 *
 * jsdom 31 runs `requestAnimationFrame` and its focus fix-up from one 16ms
 * interval, started with whatever `setInterval` is global at the time and
 * cleared once nothing is waiting. A frame or a focus change under the fake
 * clock starts it there, and a bare `vi.useRealTimers()` before the clock has
 * moved a frame strands it: jsdom never starts another, so no later test in
 * the file gets an animation frame. Three frames' worth of fake time lets the
 * interval run and stop itself first. `vitest.setup.ts` fails a file that
 * strands it.
 */
export function removeFakeClock(): void {
  if (vi.isFakeTimers()) vi.advanceTimersByTime(50);
  vi.useRealTimers();
}
