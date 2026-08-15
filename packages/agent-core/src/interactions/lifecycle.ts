type LifecycleState = "idle" | "starting" | "running" | "stopping" | "stopped";

/** Serialize one transport's single-use start and stop operations. */
export class SerializedTransportLifecycle {
  private state: LifecycleState = "idle";
  private tail: Promise<void> = Promise.resolve();

  start(open: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      if (this.state !== "idle") {
        throw new Error(`Interaction transport cannot start while ${this.state}`);
      }
      this.state = "starting";
      try {
        await open();
        this.state = "running";
      } catch (error) {
        this.state = "stopped";
        throw error;
      }
    });
  }

  stop(close: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      if (this.state === "idle" || this.state === "stopped") return;
      this.state = "stopping";
      try {
        await close();
      } finally {
        this.state = "stopped";
      }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Close active requests gracefully, then force-close a stuck local socket. */
export async function closeHttpServer(
  server: import("node:http").Server,
  graceMs = 1_000,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceClose);
      resolve();
    };
    const forceClose = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, graceMs);
    server.close(finish);
    server.closeIdleConnections?.();
  });
}

/** Give active work a bounded grace period before transport shutdown. */
export async function waitForSettled(
  promises: Iterable<Promise<unknown>>,
  graceMs = 1_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...promises]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
