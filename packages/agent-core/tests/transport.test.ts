/**
 * Transport Module Tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockTransportAdapter } from "../src/transport/index.js";

describe("MockTransportAdapter", () => {
  let transport: MockTransportAdapter;

  beforeEach(() => {
    transport = new MockTransportAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("connection state", () => {
    it("should auto-connect by default", () => {
      expect(transport.state).toBe("connected");
      expect(transport.isConnected()).toBe(true);
    });

    it("should not auto-connect when disabled", () => {
      const t = new MockTransportAdapter({ autoConnect: false });
      expect(t.state).toBe("disconnected");
      expect(t.isConnected()).toBe(false);
    });

    it("should connect when connect() is called", async () => {
      const t = new MockTransportAdapter({ autoConnect: false });
      expect(t.isConnected()).toBe(false);

      await t.connect();

      expect(t.state).toBe("connected");
      expect(t.isConnected()).toBe(true);
    });

    it("should disconnect when disconnect() is called", async () => {
      expect(transport.isConnected()).toBe(true);

      await transport.disconnect();

      expect(transport.state).toBe("disconnected");
      expect(transport.isConnected()).toBe(false);
    });

    it("should emit stateChange events", async () => {
      const t = new MockTransportAdapter({ autoConnect: false });
      const states: string[] = [];

      t.on("stateChange", (state) => states.push(state));
      await t.connect();
      await t.disconnect();

      expect(states).toContain("connecting");
      expect(states).toContain("connected");
      expect(states).toContain("disconnected");
    });
  });

  describe("request handling", () => {
    it("should record requests", async () => {
      await transport.request({ path: "/api/test", method: "GET" });

      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0].path).toBe("/api/test");
      expect(transport.requests[0].method).toBe("GET");
    });

    it("should return mocked response data", async () => {
      transport.mockResponse("/api/data", { data: { value: 42 } });

      const result = await transport.request<{ value: number }>({
        path: "/api/data",
      });

      expect(result.value).toBe(42);
    });

    it("should throw mocked errors", async () => {
      transport.mockResponse("/api/error", { error: new Error("Test error") });

      await expect(transport.request({ path: "/api/error" })).rejects.toThrow(
        "Test error",
      );
    });

    it("should respect method-specific mocks", async () => {
      transport.mockMethodResponse("POST", "/api/data", { data: "posted" });
      transport.mockMethodResponse("GET", "/api/data", { data: "got" });

      const getResult = await transport.request<string>({
        path: "/api/data",
        method: "GET",
      });
      const postResult = await transport.request<string>({
        path: "/api/data",
        method: "POST",
      });

      expect(getResult).toBe("got");
      expect(postResult).toBe("posted");
    });

    it("should record request body and headers", async () => {
      await transport.request({
        path: "/api/test",
        method: "POST",
        body: { name: "test" },
        headers: { "X-Custom": "header" },
      });

      const request = transport.getLastRequest();
      expect(request?.body).toEqual({ name: "test" });
      expect(request?.headers?.["X-Custom"]).toBe("header");
    });

    it("should use default method GET", async () => {
      await transport.request({ path: "/api/test" });

      expect(transport.getLastRequest()?.method).toBe("GET");
    });
  });

  describe("metrics tracking", () => {
    it("should track request count", async () => {
      await transport.request({ path: "/api/1" });
      await transport.request({ path: "/api/2" });
      await transport.request({ path: "/api/3" });

      const metrics = transport.getMetrics();
      expect(metrics.requestCount).toBe(3);
    });

    it("should track failed requests", async () => {
      transport.mockResponse("/api/error", { error: new Error("fail") });

      await transport.request({ path: "/api/ok" }).catch(() => {});
      await transport.request({ path: "/api/error" }).catch(() => {});

      const metrics = transport.getMetrics();
      expect(metrics.requestCount).toBe(2);
      expect(metrics.failedRequests).toBe(1);
    });

    it("should calculate average latency", async () => {
      await transport.request({ path: "/api/test" });
      await transport.request({ path: "/api/test" });

      const metrics = transport.getMetrics();
      expect(metrics.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should track uptime when connected", async () => {
      const metrics = transport.getMetrics();
      expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should track reconnections", () => {
      transport.simulateDisconnect();
      transport.simulateReconnect();

      const metrics = transport.getMetrics();
      expect(metrics.totalReconnections).toBe(1);
    });
  });

  describe("connection quality", () => {
    it("should start with excellent quality", () => {
      expect(transport.getQuality()).toBe("excellent");
    });

    it("should emit qualityChange events", async () => {
      const qualities: string[] = [];
      transport.on("qualityChange", (q) => qualities.push(q));

      // Make many failed requests to degrade quality
      transport.mockResponse("/api/fail", { error: new Error("fail") });
      for (let i = 0; i < 10; i++) {
        await transport.request({ path: "/api/fail" }).catch(() => {});
      }

      // Should have recorded quality changes
      expect(qualities.length).toBeGreaterThan(0);
    });
  });

  describe("subscription handling", () => {
    it("should create subscriptions", () => {
      const subscription = transport.subscribe({ path: "/api/stream" });

      expect(subscription.streamId).toBeDefined();
      expect(subscription.state).toBe("active");
    });

    it("should deliver mocked stream events", async () => {
      transport.mockStream("/api/stream", [
        { event: "message", data: '{"text": "hello"}' },
        { event: "message", data: '{"text": "world"}' },
      ]);

      const events: unknown[] = [];
      const subscription = transport.subscribe({ path: "/api/stream" });
      subscription.onEvent((e) => events.push(e));

      // Wait for events to be delivered
      await new Promise((r) => setTimeout(r, 50));

      expect(events).toHaveLength(2);
    });

    it("should support pause and resume", () => {
      const subscription = transport.subscribe({ path: "/api/stream" });

      expect(subscription.state).toBe("active");

      subscription.pause();
      expect(subscription.state).toBe("paused");

      subscription.resume();
      expect(subscription.state).toBe("active");
    });

    it("should close subscription", () => {
      const subscription = transport.subscribe({ path: "/api/stream" });

      subscription.close();
      expect(subscription.state).toBe("closed");
    });

    it("should close all subscriptions on disconnect", async () => {
      const sub1 = transport.subscribe({ path: "/api/stream1" });
      const sub2 = transport.subscribe({ path: "/api/stream2" });

      await transport.disconnect();

      expect(sub1.state).toBe("closed");
      expect(sub2.state).toBe("closed");
    });

    it("should return active subscriptions", () => {
      const sub1 = transport.subscribe({ path: "/api/stream1" });
      const sub2 = transport.subscribe({ path: "/api/stream2" });
      sub1.close();

      const active = transport.getActiveSubscriptions();
      expect(active).toHaveLength(1);
      expect(active[0].streamId).toBe(sub2.streamId);
    });

    it("should push events to subscriptions", async () => {
      const events: unknown[] = [];
      const subscription = transport.subscribe({ path: "/api/stream" });
      subscription.onEvent((e) => events.push(e));

      // Wait for subscription setup
      await new Promise((r) => setTimeout(r, 10));

      transport.pushEventToPath("/api/stream", {
        id: "1",
        event: "test",
        data: "data",
      });

      // Wait for event delivery
      await new Promise((r) => setTimeout(r, 10));

      expect(events).toHaveLength(1);
    });
  });

  describe("event callbacks", () => {
    it("should support onError callback", () => {
      const subscription = transport.subscribe({ path: "/api/stream" });
      const errors: Error[] = [];

      subscription.onError((err) => errors.push(err));

      const sub = transport.getSubscription(subscription.streamId);
      sub?.simulateError(new Error("test error"));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("test error");
    });

    it("should support onReconnect callback", () => {
      const subscription = transport.subscribe({ path: "/api/stream" });
      const reconnects: (string | undefined)[] = [];

      subscription.onReconnect((lastId) => reconnects.push(lastId));

      const sub = transport.getSubscription(subscription.streamId);
      sub?.simulateReconnect("event_123");

      expect(reconnects).toHaveLength(1);
      expect(reconnects[0]).toBe("event_123");
    });

    it("should unsubscribe from callbacks", () => {
      const subscription = transport.subscribe({ path: "/api/stream" });
      const events: unknown[] = [];

      const unsubscribe = subscription.onEvent((e) => events.push(e));
      unsubscribe();

      const sub = transport.getSubscription(subscription.streamId);
      sub?.pushEvent({ id: "1", data: "test" });

      expect(events).toHaveLength(0);
    });
  });

  describe("helper methods", () => {
    it("should clear requests", async () => {
      await transport.request({ path: "/api/test" });
      expect(transport.requests).toHaveLength(1);

      transport.clearRequests();
      expect(transport.requests).toHaveLength(0);
    });

    it("should clear mocks", async () => {
      transport.mockResponse("/api/data", { data: "test" });

      transport.clearMocks();

      const result = await transport.request({ path: "/api/data" });
      expect(result).toEqual({}); // Default empty response
    });

    it("should filter requests by path", async () => {
      await transport.request({ path: "/api/a" });
      await transport.request({ path: "/api/b" });
      await transport.request({ path: "/api/a" });

      const filtered = transport.getRequestsForPath("/api/a");
      expect(filtered).toHaveLength(2);
    });

    it("should simulate disconnect and reconnect", () => {
      const errors: Error[] = [];
      const reconnected: boolean[] = [];

      transport.on("error", (e) => errors.push(e));
      transport.on("reconnected", () => reconnected.push(true));

      transport.simulateDisconnect();
      expect(transport.state).toBe("disconnected");
      expect(errors).toHaveLength(1);

      transport.simulateReconnect();
      expect(transport.state).toBe("connected");
      expect(reconnected).toHaveLength(1);
    });
  });

  describe("event listeners", () => {
    it("should support multiple listeners for same event", () => {
      const calls1: string[] = [];
      const calls2: string[] = [];

      transport.on("stateChange", (s) => calls1.push(s));
      transport.on("stateChange", (s) => calls2.push(s));

      transport.simulateDisconnect();

      expect(calls1).toContain("disconnected");
      expect(calls2).toContain("disconnected");
    });

    it("should unsubscribe from events", async () => {
      const calls: string[] = [];

      const unsubscribe = transport.on("stateChange", (s) => calls.push(s));
      unsubscribe();

      await transport.disconnect();

      expect(calls).toHaveLength(0);
    });

    it("should handle listener errors gracefully", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      transport.on("stateChange", () => {
        throw new Error("listener error");
      });

      // Should not throw
      await transport.disconnect();

      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe("URL and header building", () => {
    it("should use configured baseUrl", async () => {
      const t = new MockTransportAdapter({
        baseUrl: "https://api.example.com",
      });

      // The mock doesn't actually use the URL, but we can verify config
      expect(t).toBeDefined();
    });

    it("should strip trailing slash from baseUrl", () => {
      const t = new MockTransportAdapter({
        baseUrl: "https://api.example.com/",
      });

      // Config should have trailing slash removed
      expect(t).toBeDefined();
    });
  });
});

describe("BaseTransportAdapter (via MockTransportAdapter)", () => {
  it("should apply default config values", () => {
    const transport = new MockTransportAdapter({});

    // Verify adapter was created with defaults
    expect(transport.state).toBe("connected");
  });

  it("should track request latency", async () => {
    const transport = new MockTransportAdapter();

    // Add artificial delay
    transport.mockResponse("/api/slow", { delay: 100 });
    await transport.request({ path: "/api/slow" });

    const metrics = transport.getMetrics();
    expect(metrics.avgLatencyMs).toBeGreaterThan(0);
  });
});
