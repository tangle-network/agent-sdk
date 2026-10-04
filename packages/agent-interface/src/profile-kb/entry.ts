import type {
  ProfileKbClaim,
  ProfileKbSource,
  ProfileKbSurface,
} from "./types.js";

export function claim(
  text: string,
  source: ProfileKbSource,
  basis: ProfileKbClaim["basis"] = "documented",
  audience: ProfileKbClaim["audience"] = "operator",
): ProfileKbClaim {
  return { text, basis, audience, sources: [source] };
}

/** Keep public string arrays and entry citations derived from the same claim records. */
export function kbEntry<
  const T extends {
    claims: ProfileKbClaim[];
    surfaces?: ProfileKbSurface[];
    aliases?: string[];
  },
>(entry: T) {
  const sources = new Map<string, ProfileKbSource>();
  for (const claim of entry.claims) {
    for (const source of claim.sources)
      sources.set(JSON.stringify(source), source);
  }
  const textFor = (audience: ProfileKbClaim["audience"]) =>
    entry.claims
      .filter(
        (claim) => claim.audience === audience && claim.basis !== "hypothesis",
      )
      .map((claim) => claim.text);
  return {
    ...entry,
    sources: [...sources.values()],
    prompt: textFor("agent"),
    operator: textFor("operator"),
  };
}
