/**
 * Events Module
 *
 * Event utilities for buffering, deduplication, and pub/sub.
 */

export {
  type BufferedEvent,
  EventBuffer,
  type EventBufferConfig,
} from "./buffer.js";
export {
  type ChannelConfig,
  type ChannelHandler,
  EventChannel,
} from "./channel.js";
export { type DeduplicatorConfig, EventDeduplicator } from "./deduplication.js";
