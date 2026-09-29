import { z } from "zod";

/**
 * Private adapter observation of a provider conversation or resume identity.
 * The adapter must obtain this ID from its bound provider process or API.
 * Caller keys, execution IDs, storage paths, and public session updates are not evidence.
 * The execution owner binds this observation to its own execution and session.
 * Public SSE and user-visible event streams must exclude this control event.
 * An observation establishes identity only, not native artifact completeness.
 */
export const NativeSessionObservedEventSchema = z.object({
  type: z.literal("native.session.observed"),
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/),
  nativeSessionId: z.string().min(1).max(512).regex(/^\S+$/u),
}).strict();

export type NativeSessionObservedEvent = z.infer<typeof NativeSessionObservedEventSchema>;
