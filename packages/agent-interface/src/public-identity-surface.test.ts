import { describe, expect, it } from "vitest";
// Imports go through the package root on purpose: this test pins the identity
// primitives to the public surface so an internal barrel refactor cannot
// silently drop them out from under external consumers (discovery-interface).
import {
  canonicalCandidateBytes,
  canonicalCandidateDigest,
  canonicalCandidateJson,
  sha256Bytes,
  sha256DigestSchema,
  sha256Utf8,
  type Sha256Digest,
} from "./index.js";

describe("public identity surface", () => {
  it("exposes every identity primitive from the package root", () => {
    expect(typeof canonicalCandidateBytes).toBe("function");
    expect(typeof canonicalCandidateDigest).toBe("function");
    expect(typeof canonicalCandidateJson).toBe("function");
    expect(typeof sha256Bytes).toBe("function");
    expect(typeof sha256Utf8).toBe("function");
    expect(sha256DigestSchema.safeParse("sha256:invalid").success).toBe(false);
  });

  it("keeps the digest scheme stable for cross-repo consumers", () => {
    const digest: Sha256Digest = canonicalCandidateDigest({ b: 1, a: "x" });
    expect(digest).toBe(
      "sha256:cdab067e9f3beb32d1252cfd63e492592fecbf591b0d08cadb24bb17f3864246",
    );
    expect(sha256DigestSchema.safeParse(digest).success).toBe(true);
  });
});
