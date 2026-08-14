import type { TerminalOutputEvent } from "@tangle-network/agent-interface";
import type { TerminalReplayWindow } from "@tangle-network/agent-interface";
import { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH } from "./tangle-contract-safety.js";

/** Frames retained for replay. An older cursor is refused, never skipped. */
const MAX_RETAINED_FRAMES = MAX_ARRAY_LENGTH;

/**
 * Ordered terminal frames with a replay cursor.
 *
 * Every frame takes a monotonic ordinal, and an `output` frame also takes a
 * monotonic `seq` that a consumer replays from. `since` is EXCLUSIVE: it names
 * the last sequence the consumer processed, so a reconnect resumes with
 * neither loss nor duplication. A cursor whose successor frames were evicted is
 * refused, because silently resuming after the gap would drop terminal output
 * the consumer believes it received.
 *
 * The buffer is bounded, so the accepted cursors move as frames are evicted.
 * {@link cursors} states the window they moved to: `earliest` is the oldest
 * cursor `read` accepts and delivers every retained frame from, and `latest` is
 * the newest output frame. A read with no cursor starts at `earliest`, so a
 * consumer that holds none is never locked out. A consumer that names an
 * evicted cursor is refused and told which cursor to resume from, because it
 * believes it received the frames the gap would silently drop.
 */
export class TerminalFrameLog {
  private entries: Array<{ ordinal: number; event: TerminalOutputEvent }> = [];
  private lastOrdinal = 0;
  private outputSeq = 0;
  private evictedOrdinal = 0;
  private evictedOutputSeq = 0;
  private ended = false;
  private waiters: Array<() => void> = [];

  append(event: TerminalOutputEvent): void {
    this.lastOrdinal += 1;
    this.entries.push({ ordinal: this.lastOrdinal, event });
    while (this.entries.length > MAX_RETAINED_FRAMES) {
      const dropped = this.entries.shift();
      if (dropped === undefined) continue;
      this.evictedOrdinal = dropped.ordinal;
      if (dropped.event.type === "output") this.evictedOutputSeq = dropped.event.seq;
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

  /**
   * The cursors this buffer can serve. Reading from `earliest` yields every
   * retained frame and loses no output, because eviction drops output frames in
   * sequence order and `earliest` names the newest one that was dropped.
   */
  get cursors(): TerminalReplayWindow {
    return { earliest: this.evictedOutputSeq, latest: this.outputSeq };
  }

  async *read(
    since: number | undefined,
    signal?: AbortSignal,
  ): AsyncIterable<TerminalOutputEvent> {
    signal?.throwIfAborted();
    // An absent cursor resolves to the oldest retained frame here, where the
    // read begins, so frames evicted between the call and the first iteration
    // cannot lock the consumer out of a window it never named.
    let cursor = this.ordinalForCursor(since ?? this.evictedOutputSeq);
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
    if (since > this.outputSeq) {
      throw new Error("Tangle terminal replay cursor is ahead of the retained frames");
    }
    // The oldest accepted cursor names the newest evicted output frame, so a
    // consumer holding it has processed every frame this buffer dropped and
    // receives every frame it still holds.
    if (since === this.evictedOutputSeq) return this.evictedOrdinal;
    const found = this.entries.find(
      (entry) => entry.event.type === "output" && entry.event.seq === since,
    );
    if (found === undefined) {
      // Name the live cursor in the refusal, so a consumer that read no window
      // still learns where it can resume instead of retrying the dropped one.
      throw new Error(
        `Tangle terminal replay cursor is older than the retained frame buffer; resume from cursor ${this.evictedOutputSeq}`,
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
