import type { TerminalOutputEvent } from "@tangle-network/agent-interface";
import { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH } from "./tangle-contract-safety.js";

/** Frames retained for replay. An older cursor is refused, never skipped. */
const MAX_RETAINED_FRAMES = MAX_ARRAY_LENGTH;

/**
 * Ordered terminal frames with a replay cursor.
 *
 * Every frame takes a monotonic ordinal, and an `output` frame also takes a
 * monotonic `seq` that a consumer replays from. `since` is EXCLUSIVE: it names
 * the last sequence the consumer processed, so a reconnect resumes with
 * neither loss nor duplication. A cursor the buffer no longer retains is
 * refused, because silently resuming after the gap would drop terminal output
 * the consumer believes it received.
 */
export class TerminalFrameLog {
  private entries: Array<{ ordinal: number; event: TerminalOutputEvent }> = [];
  private lastOrdinal = 0;
  private outputSeq = 0;
  private evictedOrdinal = 0;
  private ended = false;
  private waiters: Array<() => void> = [];

  append(event: TerminalOutputEvent): void {
    this.lastOrdinal += 1;
    this.entries.push({ ordinal: this.lastOrdinal, event });
    while (this.entries.length > MAX_RETAINED_FRAMES) {
      const dropped = this.entries.shift();
      if (dropped !== undefined) this.evictedOrdinal = dropped.ordinal;
    }
    this.wake();
  }

  /** Append decoded PTY text, split so no frame exceeds the contract bound. */
  appendOutput(text: string): void {
    for (let offset = 0; offset < text.length; offset += MAX_STRING_LENGTH) {
      this.outputSeq += 1;
      this.append({
        type: "output",
        seq: this.outputSeq,
        data: text.slice(offset, offset + MAX_STRING_LENGTH),
      });
    }
  }

  /** No more frames will arrive; readers drain what is retained and return. */
  end(): void {
    this.ended = true;
    this.wake();
  }

  get latestSeq(): number {
    return this.outputSeq;
  }

  async *read(
    since: number,
    signal?: AbortSignal,
  ): AsyncIterable<TerminalOutputEvent> {
    signal?.throwIfAborted();
    let cursor = this.ordinalForCursor(since);
    while (true) {
      signal?.throwIfAborted();
      if (this.evictedOrdinal > cursor) {
        throw new Error(
          "Tangle terminal frames were evicted before this consumer read them",
        );
      }
      const pending = this.entries.filter((entry) => entry.ordinal > cursor);
      if (pending.length > 0) {
        for (const entry of pending) {
          cursor = entry.ordinal;
          yield entry.event;
          signal?.throwIfAborted();
        }
        continue;
      }
      if (this.ended) return;
      await this.waitForFrames(signal);
    }
  }

  private ordinalForCursor(since: number): number {
    if (!Number.isSafeInteger(since) || since < 0) {
      throw new Error(
        "Tangle terminal replay cursor must be a non-negative safe integer",
      );
    }
    if (since === 0) return 0;
    if (since > this.outputSeq) {
      throw new Error("Tangle terminal replay cursor is ahead of the retained frames");
    }
    const found = this.entries.find(
      (entry) => entry.event.type === "output" && entry.event.seq === since,
    );
    if (found === undefined) {
      throw new Error(
        "Tangle terminal replay cursor is older than the retained frame buffer",
      );
    }
    return found.ordinal;
  }

  private waitForFrames(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const wake = (): void => {
        if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.push(wake);
      if (signal !== undefined) {
        onAbort = (): void => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("The operation was aborted", "AbortError"),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}
