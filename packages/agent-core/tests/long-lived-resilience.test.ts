import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SDKError } from '../src/errors/index.js';
import { createTimeoutController, sleep, withTimeout } from '../src/resilience/timeout.js';
import { withRetry } from '../src/retry/index.js';

const MONTH = 30 * 24 * 60 * 60 * 1000;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('long-lived resilience', () => {
  it('removes abort listeners after every successful sleep', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    for (let i = 0; i < 20; i++) {
      const waiting = sleep(10, controller.signal);
      await vi.advanceTimersByTimeAsync(10);
      await waiting;
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  });

  it('does not collapse a month-long sleep to one millisecond', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const controller = new AbortController();
    let settled = false;
    const waiting = sleep(MONTH, controller.signal).then(() => { settled = true; }, error => error);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(false);
    controller.abort(new Error('stop'));
    expect(await waiting).toMatchObject({ message: 'stop' });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('keeps a long promise timeout and returns work completed before it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let finish!: (value: string) => void;
    const promise = new Promise<string>(resolve => { finish = resolve; });
    let settled = false;
    const result = withTimeout(promise, MONTH).then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(false);
    finish('retained');
    expect(await result).toBe('retained');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts at a long controller deadline, not at the native timer overflow', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { controller, cleanup } = createTimeoutController(MONTH);
    await vi.advanceTimersByTimeAsync(MONTH - 1);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.reason).toMatchObject({ name: 'TimeoutError', timeoutMs: MONTH });
    cleanup(); cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('respects a long server Retry-After without dispatching during the wait', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new SDKError('quota', { code: 'RATE_LIMITED', retryable: true, retryAfterMs: MONTH }));
    const result = withRetry(fn, { maxAttempts: 2, signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(2);
    expect(fn).toHaveBeenCalledTimes(1);
    controller.abort(new Error('cancelled'));
    expect(await result).toMatchObject({ message: 'cancelled' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
