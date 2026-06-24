import { describe, expect, it } from "vitest";
import {
  authorizeSidecarToken,
  requiredCapabilityForPath,
} from "../../src/auth/tokens.js";

/**
 * The terminal/ssh WebSocket upgrade paths are the raw-input interactive
 * surface and must require the `terminal` capability, while the sibling REST
 * route `/terminals/commands` (public SDK + artifact queue) must stay OUT of
 * the gate so a prefix match does not break those master-token callers.
 */
describe("terminal capability gating (interactive-session hole #3)", () => {
  it("requires `terminal` on the terminal WS upgrade path", () => {
    expect(requiredCapabilityForPath("/terminals/conn-123/ws")).toBe(
      "terminal",
    );
  });

  it("requires `terminal` on the ssh path (with and without trailing slash)", () => {
    expect(requiredCapabilityForPath("/ssh")).toBe("terminal");
    expect(requiredCapabilityForPath("/ssh/")).toBe("terminal");
  });

  it("does NOT gate /terminals/commands (REST one-shot exec, master-token callers)", () => {
    expect(requiredCapabilityForPath("/terminals/commands")).toBeNull();
  });

  it("does NOT gate a non-ws terminal subpath", () => {
    expect(requiredCapabilityForPath("/terminals/conn-123")).toBeNull();
    expect(requiredCapabilityForPath("/terminals/conn-123/history")).toBeNull();
  });

  it("rejects the master token (no cap claim) on the gated WS paths", () => {
    // cap === undefined is the legacy full-scope master token; it must be
    // rejected on a capability-gated route exactly like /computer-use.
    expect(authorizeSidecarToken({}, "/terminals/conn-123/ws", "GET")).toBe(
      false,
    );
    expect(authorizeSidecarToken({}, "/ssh", "GET")).toBe(false);
  });

  it("accepts a cap:['terminal'] token on the gated WS paths", () => {
    expect(
      authorizeSidecarToken({ cap: ["terminal"] }, "/terminals/c/ws", "GET"),
    ).toBe(true);
    expect(authorizeSidecarToken({ cap: ["terminal"] }, "/ssh", "GET")).toBe(
      true,
    );
  });

  it("rejects a differently-scoped token (e.g. read/computer_use) on the WS paths", () => {
    expect(
      authorizeSidecarToken({ cap: ["read"] }, "/terminals/c/ws", "GET"),
    ).toBe(false);
    expect(
      authorizeSidecarToken({ cap: ["computer_use"] }, "/ssh", "GET"),
    ).toBe(false);
  });

  it("still lets the master token reach /terminals/commands (capability preserved)", () => {
    expect(authorizeSidecarToken({}, "/terminals/commands", "POST")).toBe(true);
  });

  it("rejects a cap:['terminal'] token on /terminals/commands (bidirectional isolation)", () => {
    // The terminal cap is scoped to the WS surface only; it must NOT unlock the
    // one-shot REST exec route. A scoped token on a non-gated route is rejected.
    expect(
      authorizeSidecarToken(
        { cap: ["terminal"] },
        "/terminals/commands",
        "POST",
      ),
    ).toBe(false);
  });

  it("does NOT gate a multi-segment /terminals/a/b/ws (under-anchored-segment bypass guard)", () => {
    // [^/]+ matches exactly one segment, so a multi-segment id cannot smuggle
    // past the anchored pattern into an ungated (master-token) path.
    expect(requiredCapabilityForPath("/terminals/a/b/ws")).toBeNull();
  });

  it("authorizes a cap:['terminal'] token on /ssh/ (trailing-slash variant)", () => {
    expect(authorizeSidecarToken({ cap: ["terminal"] }, "/ssh/", "GET")).toBe(
      true,
    );
    expect(authorizeSidecarToken({}, "/ssh/", "GET")).toBe(false);
  });
});
