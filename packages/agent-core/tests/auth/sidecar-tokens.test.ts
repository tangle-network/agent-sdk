import { sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateSidecarKeyPair,
  issueSidecarAccessToken,
  verifySidecarToken,
} from "../../src/auth/tokens.js";

describe("Ed25519 Sidecar Token Auth", () => {
  const keyPair = generateSidecarKeyPair();
  const fullContainerId =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const payload = {
    sub: "user-123",
    pid: "product-456",
    cid: fullContainerId,
    sid: "session-xyz",
  };

  describe("generateSidecarKeyPair", () => {
    it("produces PEM-encoded Ed25519 keys", () => {
      const kp = generateSidecarKeyPair();
      expect(kp.privateKey).toContain("BEGIN PRIVATE KEY");
      expect(kp.privateKey).toContain("END PRIVATE KEY");
      expect(kp.publicKey).toContain("BEGIN PUBLIC KEY");
      expect(kp.publicKey).toContain("END PUBLIC KEY");
    });

    it("generates unique key pairs on each call", () => {
      const kp1 = generateSidecarKeyPair();
      const kp2 = generateSidecarKeyPair();
      expect(kp1.privateKey).not.toBe(kp2.privateKey);
      expect(kp1.publicKey).not.toBe(kp2.publicKey);
    });
  });

  describe("issueSidecarAccessToken", () => {
    it("produces a 3-part JWT with EdDSA header", () => {
      const token = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const parts = token.split(".");
      expect(parts).toHaveLength(3);

      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      expect(header.alg).toBe("EdDSA");
      expect(header.typ).toBe("JWT");
    });

    it("sets correct claims in payload", () => {
      const token = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const parts = token.split(".");
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      expect(claims.sub).toBe("user-123");
      expect(claims.pid).toBe("product-456");
      expect(claims.cid).toBe(fullContainerId);
      expect(claims.sid).toBe("session-xyz");
      expect(claims.typ).toBe("sidecar");
      expect(claims.iat).toBeTypeOf("number");
      expect(claims.exp).toBeTypeOf("number");
      expect(claims.exp - claims.iat).toBe(300); // 5 minutes
    });

    it("throws if given a non-PEM key (HMAC secret)", () => {
      expect(() =>
        issueSidecarAccessToken("not-a-pem-key", payload, 5),
      ).toThrow("Ed25519 private key");
    });

    it("throws if given a public key instead of private", () => {
      expect(() =>
        issueSidecarAccessToken(keyPair.publicKey, payload, 5),
      ).toThrow();
    });
  });

  describe("verifySidecarToken", () => {
    it("round-trips: issue then verify succeeds", () => {
      const token = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const result = verifySidecarToken(
        token,
        keyPair.publicKey,
        fullContainerId,
      );
      expect(result).not.toBeNull();
      if (!result) throw new Error("unreachable");
      expect(result.sub).toBe("user-123");
      expect(result.cid).toBe(fullContainerId);
    });

    it("rejects token signed with different key", () => {
      const otherKey = generateSidecarKeyPair();
      const token = issueSidecarAccessToken(otherKey.privateKey, payload, 5);
      const result = verifySidecarToken(
        token,
        keyPair.publicKey,
        fullContainerId,
      );
      expect(result).toBeNull();
    });

    it("rejects expired token", () => {
      // Issue token with -1 minute TTL (already expired)
      const token = issueSidecarAccessToken(keyPair.privateKey, payload, -1);
      const result = verifySidecarToken(
        token,
        keyPair.publicKey,
        "container-abc",
      );
      expect(result).toBeNull();
    });

    it("rejects token with wrong cid", () => {
      const token = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const result = verifySidecarToken(
        token,
        keyPair.publicKey,
        "wrong-container",
      );
      expect(result).toBeNull();
    });

    it("accepts Docker short-hostname container IDs as a prefix match", () => {
      const token = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const shortDockerId = payload.cid.slice(0, 12);
      const result = verifySidecarToken(
        token,
        keyPair.publicKey,
        shortDockerId,
      );
      expect(result).not.toBeNull();
      if (!result) throw new Error("unreachable");
      expect(result.cid).toBe(fullContainerId);
    });

    it("accepts non-docker-format container IDs via exact match (firecracker)", () => {
      // FC's vm.id (and therefore the signed cid) is a sessionId — not a
      // 64-hex docker container id. isDockerShortIdMatch's strict regex
      // refuses to bridge it, so verify must succeed only on exact equality
      // between the signed cid and process.env.CONTAINER_ID/HOSTNAME.
      const fcSessionId = "fc-session-7a9c4e2b-1234";
      const fcPayload = { ...payload, cid: fcSessionId };
      const token = issueSidecarAccessToken(keyPair.privateKey, fcPayload, 5);
      const result = verifySidecarToken(token, keyPair.publicKey, fcSessionId);
      expect(result).not.toBeNull();
      if (!result) throw new Error("unreachable");
      expect(result.cid).toBe(fcSessionId);
    });

    it("rejects arbitrary string prefix matches", () => {
      const prefixedPayload = {
        ...payload,
        cid: "container-abc-malicious",
      };
      const token = issueSidecarAccessToken(
        keyPair.privateKey,
        prefixedPayload,
        5,
      );
      const result = verifySidecarToken(
        token,
        keyPair.publicKey,
        "container-abc",
      );
      expect(result).toBeNull();
    });

    it("rejects HS256 downgrade attack", () => {
      // Forge an HMAC token with alg: "HS256" — must be rejected
      const header = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" }),
      ).toString("base64url");
      const claims = Buffer.from(
        JSON.stringify({ ...payload, typ: "sidecar", iat: 0, exp: 9999999999 }),
      ).toString("base64url");
      const fakeToken = `${header}.${claims}.fake-signature`;
      const result = verifySidecarToken(
        fakeToken,
        keyPair.publicKey,
        fullContainerId,
      );
      expect(result).toBeNull();
    });

    it("rejects token with wrong typ", () => {
      // Modify payload to have typ: "read" instead of "sidecar"
      const token = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const parts = token.split(".");
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      claims.typ = "read";
      const tamperedPayload = Buffer.from(JSON.stringify(claims)).toString(
        "base64url",
      );
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
      const result = verifySidecarToken(
        tamperedToken,
        keyPair.publicKey,
        fullContainerId,
      );
      // Tampered payload = signature mismatch → rejected
      expect(result).toBeNull();
    });

    it("rejects malformed tokens", () => {
      expect(verifySidecarToken("", keyPair.publicKey, "c")).toBeNull();
      expect(verifySidecarToken("a.b", keyPair.publicKey, "c")).toBeNull();
      expect(verifySidecarToken("a.b.c.d", keyPair.publicKey, "c")).toBeNull();
      expect(
        verifySidecarToken("not-base64!.x.y", keyPair.publicKey, "c"),
      ).toBeNull();
    });

    it("rejects token with missing sub claim", () => {
      const noSub = { pid: "p", cid: payload.cid };
      const token = issueSidecarAccessToken(
        keyPair.privateKey,
        { ...noSub, sub: "" },
        5,
      );
      const result = verifySidecarToken(
        token,
        keyPair.publicKey,
        fullContainerId,
      );
      expect(result).toBeNull();
    });

    it("rejects token with empty cid", () => {
      const emptyCid = { sub: "user", pid: "p", cid: "" };
      const token = issueSidecarAccessToken(keyPair.privateKey, emptyCid, 5);
      // containerId is the real container ID but token has cid: "" → mismatch
      const result = verifySidecarToken(
        token,
        keyPair.publicKey,
        fullContainerId,
      );
      expect(result).toBeNull();
    });

    it("verifies signature BEFORE checking claims (timing oracle prevention)", () => {
      // Forge a token with correct cid but wrong signature.
      // If claims were checked before signature, the cid check would pass,
      // then signature would fail → different timing than wrong-cid token.
      // With signature-first, both paths take the same time (sig verification).
      const token = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const parts = token.split(".");
      // Corrupt the signature
      const corruptSig = parts[2].replace(
        parts[2][0],
        parts[2][0] === "A" ? "B" : "A",
      );
      const corruptToken = `${parts[0]}.${parts[1]}.${corruptSig}`;
      const result = verifySidecarToken(
        corruptToken,
        keyPair.publicKey,
        fullContainerId,
      );
      expect(result).toBeNull();
    });

    it("returns jti claim in verified payload", () => {
      const token = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const result = verifySidecarToken(
        token,
        keyPair.publicKey,
        fullContainerId,
      );
      expect(result).not.toBeNull();
      if (!result) throw new Error("unreachable");
      expect(result.jti).toBeTypeOf("string");
      expect(result.jti?.length).toBeGreaterThan(10);
      expect(result.jti).toContain(`${fullContainerId}:`);
    });

    it("rejects tokens without a jti claim", () => {
      const token = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const [header, encodedClaims] = token.split(".");
      const claims = JSON.parse(
        Buffer.from(encodedClaims, "base64url").toString("utf-8"),
      );
      delete claims.jti;
      const tamperedPayload = Buffer.from(JSON.stringify(claims)).toString(
        "base64url",
      );
      const data = `${header}.${tamperedPayload}`;
      const signature = Buffer.from(
        sign(null, Buffer.from(data), keyPair.privateKey),
      ).toString("base64url");
      const rebuiltToken = `${data}.${signature}`;

      const result = verifySidecarToken(
        rebuiltToken,
        keyPair.publicKey,
        fullContainerId,
      );
      expect(result).toBeNull();
    });

    it("generates unique jti per token", () => {
      const t1 = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const t2 = issueSidecarAccessToken(keyPair.privateKey, payload, 5);
      const r1 = verifySidecarToken(t1, keyPair.publicKey, fullContainerId);
      const r2 = verifySidecarToken(t2, keyPair.publicKey, fullContainerId);
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      if (!r1 || !r2) throw new Error("unreachable");
      expect(r1.jti).not.toBe(r2.jti);
    });
  });

  describe("capability-scoped tokens", () => {
    it("round-trips the cap claim", () => {
      const token = issueSidecarAccessToken(
        keyPair.privateKey,
        { ...payload, cap: ["computer_use"] },
        5,
      );
      const result = verifySidecarToken(
        token,
        keyPair.publicKey,
        fullContainerId,
      );
      expect(result?.cap).toEqual(["computer_use"]);
    });
  });
});
