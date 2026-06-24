/**
 * Shared Auth Providers
 *
 * Browser-safe auth classes shared between index.ts and browser.ts.
 * These classes have no node:crypto dependency and work in all environments.
 */

import { SDKError } from "../errors/index.js";

/** Auth provider interface */
export interface AuthProvider {
  /** Get current token (called on each request) */
  getToken(): Promise<string | null>;
  /** Refresh expired token */
  refreshToken?(): Promise<string>;
  /** Called when token is rejected by server */
  onTokenRejected?(error: SDKError): Promise<void>;
}

/** Simple static token auth */
export class StaticTokenAuth implements AuthProvider {
  constructor(private token: string) {}

  async getToken(): Promise<string> {
    return this.token;
  }

  setToken(token: string): void {
    this.token = token;
  }
}

/** Token with refresh capability */
export class RefreshableTokenAuth implements AuthProvider {
  private accessToken: string;
  private refreshTokenValue: string;
  private expiresAt: number;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private config: {
      accessToken: string;
      refreshToken: string;
      expiresIn: number; // seconds
      onRefresh: (refreshToken: string) => Promise<{
        accessToken: string;
        refreshToken?: string;
        expiresIn: number;
      }>;
      onRefreshFailed?: (error: Error) => void;
      /** Buffer before expiry to trigger refresh (default: 60s) */
      refreshBuffer?: number;
    },
  ) {
    this.accessToken = config.accessToken;
    this.refreshTokenValue = config.refreshToken;
    this.expiresAt = Date.now() + config.expiresIn * 1000;
  }

  async getToken(): Promise<string> {
    const buffer = (this.config.refreshBuffer ?? 60) * 1000;

    // Proactively refresh if close to expiry
    if (Date.now() > this.expiresAt - buffer) {
      return this.refreshToken();
    }

    return this.accessToken;
  }

  async refreshToken(): Promise<string> {
    // Deduplicate concurrent refresh calls
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<string> {
    try {
      const result = await this.config.onRefresh(this.refreshTokenValue);
      this.accessToken = result.accessToken;
      if (result.refreshToken) {
        this.refreshTokenValue = result.refreshToken;
      }
      this.expiresAt = Date.now() + result.expiresIn * 1000;
      return this.accessToken;
    } catch (error) {
      this.config.onRefreshFailed?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new SDKError("Token refresh failed", {
        code: "AUTH",
        retryable: false,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async onTokenRejected(error: SDKError): Promise<void> {
    // Force refresh on 401
    if (error.status === 401) {
      this.expiresAt = 0; // Mark as expired
    }
  }

  /** Check if token needs refresh */
  isExpired(): boolean {
    return Date.now() > this.expiresAt;
  }
}

/** No auth (for public endpoints) */
export class NoAuth implements AuthProvider {
  async getToken(): Promise<null> {
    return null;
  }
}

/**
 * Callback-based auth for dynamic token retrieval.
 * Useful when token comes from external source (user session, secure storage).
 */
export class CallbackAuth implements AuthProvider {
  constructor(
    private getTokenFn: () => string | null | Promise<string | null>,
  ) {}

  async getToken(): Promise<string | null> {
    return this.getTokenFn();
  }
}

/**
 * Read token auth for WebSocket connections.
 * Wraps a read token with refresh capability.
 */
export class ReadTokenAuth implements AuthProvider {
  private token: string;
  private expiresAt: number;
  private refreshPromise: Promise<string> | null = null;
  private expiryWarned = false;

  constructor(
    private config: {
      token: string;
      expiresAt: number; // Unix timestamp (seconds)
      onRefresh: () => Promise<{ token: string; expiresAt: number }>;
      onExpiring?: (secondsRemaining: number) => void;
      onRefreshFailed?: (error: Error) => void;
      /** Buffer before expiry to trigger refresh (default: 60s) */
      refreshBuffer?: number;
      /** Buffer before expiry to trigger warning (default: 60s) */
      warningBuffer?: number;
    },
  ) {
    this.token = config.token;
    this.expiresAt = config.expiresAt * 1000; // Convert to ms
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    const refreshBuffer = (this.config.refreshBuffer ?? 60) * 1000;
    const warningBuffer = (this.config.warningBuffer ?? 60) * 1000;

    // Warn if expiring soon
    if (!this.expiryWarned && now > this.expiresAt - warningBuffer) {
      this.expiryWarned = true;
      const secondsRemaining = Math.floor((this.expiresAt - now) / 1000);
      this.config.onExpiring?.(secondsRemaining);
    }

    // Proactively refresh if close to expiry
    if (now > this.expiresAt - refreshBuffer) {
      return this.refreshToken();
    }

    return this.token;
  }

  async refreshToken(): Promise<string> {
    // Deduplicate concurrent refresh calls
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<string> {
    try {
      const result = await this.config.onRefresh();
      this.token = result.token;
      this.expiresAt = result.expiresAt * 1000;
      this.expiryWarned = false;
      return this.token;
    } catch (error) {
      this.config.onRefreshFailed?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  /** Check if token is expired */
  isExpired(): boolean {
    return Date.now() > this.expiresAt;
  }

  /** Get seconds until expiry */
  getSecondsRemaining(): number {
    return Math.floor((this.expiresAt - Date.now()) / 1000);
  }
}
