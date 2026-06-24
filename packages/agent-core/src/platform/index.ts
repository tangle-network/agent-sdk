/**
 * Platform Abstraction Layer
 *
 * Interfaces and adapters that enable the SDK to run across
 * mobile, desktop, TUI, and web without vendor lock-in.
 *
 * Each platform provides its own implementations:
 * - Web: localStorage, navigator.onLine, fetch
 * - React Native: AsyncStorage, NetInfo, fetch polyfill
 * - Electron: electron-store, net module, node-fetch
 * - Tauri: tauri-plugin-store, tauri events, fetch
 * - Node/TUI: fs-based, always online, node-fetch
 */

import { detectStorage, type Storage } from "../storage/index.js";

/**
 * Secure credential storage interface.
 * Implementations should use platform-specific secure storage:
 * - Web: Encrypted localStorage or IndexedDB
 * - React Native: react-native-keychain
 * - Electron: safeStorage + electron-store
 * - Tauri: tauri-plugin-keyring
 * - Node: keytar or encrypted file
 */
export interface SecureStorage {
  /** Store a credential securely */
  setCredential(key: string, value: string): Promise<void>;
  /** Retrieve a credential */
  getCredential(key: string): Promise<string | null>;
  /** Delete a credential */
  deleteCredential(key: string): Promise<void>;
  /** Check if secure storage is available */
  isAvailable(): Promise<boolean>;
}

/**
 * Network connectivity information.
 * Implementations should use platform-specific APIs:
 * - Web: navigator.onLine + online/offline events
 * - React Native: @react-native-community/netinfo
 * - Electron: net.online
 * - Tauri: network events
 * - Node/TUI: assume online or use dns lookup
 */
export interface NetworkInfo {
  /** Check if device is online */
  isOnline(): boolean;
  /** Subscribe to connectivity changes */
  onConnectivityChange(callback: (online: boolean) => void): () => void;
  /** Get connection quality hint (optional) */
  getConnectionType?(): "wifi" | "cellular" | "ethernet" | "unknown";
}

/**
 * State persistence adapter for cross-session state.
 * Handles syncing SDK state (sessions, queued requests, cache)
 * to platform-appropriate storage.
 */
export interface PersistenceAdapter {
  /** Save state snapshot */
  saveState<T>(namespace: string, state: T): Promise<void>;
  /** Load state snapshot */
  loadState<T>(namespace: string): Promise<T | null>;
  /** Clear namespace */
  clearState(namespace: string): Promise<void>;
  /** Subscribe to external state changes (for multi-window/tab sync) */
  onExternalChange?(
    namespace: string,
    callback: (state: unknown) => void,
  ): () => void;
}

/**
 * Platform capabilities descriptor.
 * Used to adapt SDK behavior to platform constraints.
 */
export interface PlatformCapabilities {
  /** Platform identifier */
  platform: "web" | "react-native" | "electron" | "tauri" | "node";
  /** Supports background execution */
  supportsBackground: boolean;
  /** Supports secure credential storage */
  supportsSecureStorage: boolean;
  /** Supports WebSocket */
  supportsWebSocket: boolean;
  /** Supports SSE (EventSource) */
  supportsSSE: boolean;
  /** Max concurrent connections (browser limits) */
  maxConnections?: number;
}

/**
 * Platform adapter combining all platform-specific interfaces.
 * Each platform provides one implementation of this interface.
 */
export interface PlatformAdapter {
  /** Platform capabilities */
  capabilities: PlatformCapabilities;
  /** General key-value storage */
  storage: Storage;
  /** Secure credential storage (optional) */
  secureStorage?: SecureStorage;
  /** Network info (optional) */
  network?: NetworkInfo;
  /** State persistence (optional) */
  persistence?: PersistenceAdapter;
  /** Fetch implementation */
  fetch: typeof fetch;
}

// ============================================================================
// Default Implementations
// ============================================================================

/**
 * In-memory secure storage fallback.
 * NOT SECURE - use only for development/testing.
 */
export class MemorySecureStorage implements SecureStorage {
  private credentials = new Map<string, string>();

  async setCredential(key: string, value: string): Promise<void> {
    this.credentials.set(key, value);
  }

  async getCredential(key: string): Promise<string | null> {
    return this.credentials.get(key) ?? null;
  }

  async deleteCredential(key: string): Promise<void> {
    this.credentials.delete(key);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/**
 * Browser-based network info using navigator.onLine.
 */
export class BrowserNetworkInfo implements NetworkInfo {
  isOnline(): boolean {
    return typeof navigator !== "undefined" ? navigator.onLine : true;
  }

  onConnectivityChange(callback: (online: boolean) => void): () => void {
    if (typeof window === "undefined") {
      return () => {};
    }

    const onOnline = () => callback(true);
    const onOffline = () => callback(false);

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }

  getConnectionType(): "wifi" | "cellular" | "ethernet" | "unknown" {
    // Use Network Information API if available
    const nav = navigator as Navigator & {
      connection?: { effectiveType?: string; type?: string };
    };
    if (nav.connection?.type) {
      const type = nav.connection.type;
      if (type === "wifi") return "wifi";
      if (type === "cellular") return "cellular";
      if (type === "ethernet") return "ethernet";
    }
    return "unknown";
  }
}

/**
 * Node.js network info (assumes always online).
 */
export class NodeNetworkInfo implements NetworkInfo {
  isOnline(): boolean {
    return true;
  }

  onConnectivityChange(_callback: (online: boolean) => void): () => void {
    // Node doesn't have native connectivity events
    return () => {};
  }
}

/**
 * Storage-based persistence adapter.
 * Uses provided Storage implementation for state persistence.
 */
export class StoragePersistence implements PersistenceAdapter {
  constructor(private storage: Storage) {}

  async saveState<T>(namespace: string, state: T): Promise<void> {
    await this.storage.set(`state:${namespace}`, state);
  }

  async loadState<T>(namespace: string): Promise<T | null> {
    return this.storage.get<T>(`state:${namespace}`);
  }

  async clearState(namespace: string): Promise<void> {
    await this.storage.delete(`state:${namespace}`);
  }
}

/**
 * Browser persistence with localStorage and storage events for tab sync.
 */
export class BrowserPersistence implements PersistenceAdapter {
  private prefix: string;

  constructor(prefix = "sdk_state:") {
    this.prefix = prefix;
  }

  async saveState<T>(namespace: string, state: T): Promise<void> {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`${this.prefix}${namespace}`, JSON.stringify(state));
  }

  async loadState<T>(namespace: string): Promise<T | null> {
    if (typeof localStorage === "undefined") return null;
    const value = localStorage.getItem(`${this.prefix}${namespace}`);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async clearState(namespace: string): Promise<void> {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(`${this.prefix}${namespace}`);
  }

  onExternalChange(
    namespace: string,
    callback: (state: unknown) => void,
  ): () => void {
    if (typeof window === "undefined") {
      return () => {};
    }

    const key = `${this.prefix}${namespace}`;
    const handler = (event: StorageEvent) => {
      if (event.key === key && event.newValue) {
        try {
          callback(JSON.parse(event.newValue));
        } catch {
          // Ignore parse errors
        }
      }
    };

    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }
}

// ============================================================================
// Platform Detection and Default Adapter
// ============================================================================

/**
 * Detect current platform.
 */
export function detectPlatform(): PlatformCapabilities["platform"] {
  // Check for Tauri
  if (
    typeof window !== "undefined" &&
    "__TAURI__" in (window as unknown as Record<string, unknown>)
  ) {
    return "tauri";
  }

  // Check for Electron
  if (
    typeof process !== "undefined" &&
    process.versions &&
    "electron" in process.versions
  ) {
    return "electron";
  }

  // Check for React Native
  if (typeof navigator !== "undefined" && navigator.product === "ReactNative") {
    return "react-native";
  }

  // Check for browser
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    return "web";
  }

  // Default to Node
  return "node";
}

/**
 * Create default platform adapter for current environment.
 * Override with platform-specific implementations for better integration.
 */
export function createDefaultPlatformAdapter(): PlatformAdapter {
  const platform = detectPlatform();
  const isBrowser = platform === "web" || platform === "tauri";
  const storage = detectStorage();

  const capabilities: PlatformCapabilities = {
    platform,
    supportsBackground: platform === "node" || platform === "electron",
    supportsSecureStorage: false, // Requires platform-specific impl
    supportsWebSocket: true,
    supportsSSE: true,
    maxConnections: isBrowser ? 6 : undefined,
  };

  return {
    capabilities,
    storage,
    secureStorage: new MemorySecureStorage(), // Fallback, not secure
    network: isBrowser ? new BrowserNetworkInfo() : new NodeNetworkInfo(),
    persistence: isBrowser
      ? new BrowserPersistence()
      : new StoragePersistence(storage),
    fetch: globalThis.fetch.bind(globalThis),
  };
}

/**
 * Type-safe platform adapter factory.
 * Use this to create platform adapters with proper typing.
 */
export function createPlatformAdapter(
  config: Partial<PlatformAdapter> & { capabilities: PlatformCapabilities },
): PlatformAdapter {
  const defaults = createDefaultPlatformAdapter();
  return {
    ...defaults,
    ...config,
  };
}
