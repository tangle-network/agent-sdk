/** Every requirement id in SPEC.md section 3, in spec order. */
export const REQUIREMENT_IDS = [
  "CAP-1", "CAP-2", "CAP-3", "CAP-4", "CAP-5", "CAP-6",
  "CRT-1", "CRT-2", "CRT-3", "CRT-4", "CRT-5", "CRT-6", "CRT-7", "CRT-8",
  "MAT-1", "MAT-2", "MAT-3", "MAT-4", "MAT-5", "MAT-6", "MAT-7", "MAT-8",
  "MOD-1", "MOD-2", "MOD-3", "MOD-4", "MOD-5",
  "SEC-1", "SEC-2", "SEC-3",
  "TRN-1", "TRN-2", "TRN-3", "TRN-4", "TRN-5", "TRN-6", "TRN-7", "TRN-8", "TRN-9", "TRN-10",
  "USE-1", "USE-2", "USE-3", "USE-4", "USE-5",
  "WSP-1", "WSP-2", "WSP-3", "WSP-4", "WSP-5", "WSP-6", "WSP-7", "WSP-8",
  "CAN-1", "CAN-2", "CAN-3", "CAN-4",
  "TDN-1", "TDN-2", "TDN-3", "TDN-4", "TDN-5",
  "ERR-1", "ERR-2", "ERR-3",
  "CON-1", "OPT-1",
] as const;

export type RequirementId = (typeof REQUIREMENT_IDS)[number];

/**
 * `pass` and `fail` are observed against the live provider. `skip` means the
 * run could not start (no credential). `unproven` means this seam has no probe
 * for the requirement, and says why; it is never counted as a pass.
 */
export type LiveStatus = "pass" | "fail" | "skip" | "unproven";

export interface LiveRequirementResult {
  id: RequirementId;
  status: LiveStatus;
  detail: string;
}

export interface LiveConformanceReport {
  provider: string;
  runTag: string;
  harness: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  /** Set when the whole run was skipped, for example `no credential: TANGLE_API_KEY`. */
  skipped?: string;
  counts: Record<LiveStatus, number>;
  results: LiveRequirementResult[];
  /** Probe stages that threw before finishing; the requirements they cover stay unobserved. */
  stageErrors: string[];
}

/** Collects observations. Any failed observation fails the requirement; a requirement with none stays unproven. */
export class Recorder {
  private readonly observations = new Map<RequirementId, { ok: boolean; detail: string }[]>();
  private readonly notes = new Map<RequirementId, string>();

  observe(id: RequirementId, ok: boolean, detail: string): void {
    const list = this.observations.get(id) ?? [];
    list.push({ ok, detail });
    this.observations.set(id, list);
  }

  pass(id: RequirementId, detail: string): void {
    this.observe(id, true, detail);
  }

  fail(id: RequirementId, detail: string): void {
    this.observe(id, false, detail);
  }

  /** Record why a requirement has no probe at this seam. Used only when nothing else observed it. */
  unproven(id: RequirementId, reason: string): void {
    this.notes.set(id, reason);
  }

  results(skipped?: string): LiveRequirementResult[] {
    return REQUIREMENT_IDS.map((id) => {
      if (skipped !== undefined) return { id, status: "skip", detail: skipped };
      const list = this.observations.get(id);
      if (list === undefined) {
        return { id, status: "unproven", detail: this.notes.get(id) ?? "no probe at the provider seam" };
      }
      const failures = list.filter((entry) => !entry.ok);
      const shown = failures.length > 0 ? failures : list;
      return { id, status: failures.length > 0 ? "fail" : "pass", detail: shown.map((entry) => entry.detail).join("; ") };
    });
  }
}

export function summarize(results: readonly LiveRequirementResult[]): Record<LiveStatus, number> {
  const counts: Record<LiveStatus, number> = { pass: 0, fail: 0, skip: 0, unproven: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

export function formatLiveReport(report: LiveConformanceReport): string {
  const lines = [
    `live profile conformance: ${report.provider} (${report.harness}, ${report.model}) run ${report.runTag}`,
    report.skipped === undefined
      ? `pass ${report.counts.pass}  fail ${report.counts.fail}  unproven ${report.counts.unproven}  of ${report.results.length}`
      : `SKIPPED: ${report.skipped}`,
  ];
  for (const stage of report.stageErrors) lines.push(`STAGE    ${stage}`);
  for (const result of report.results) {
    lines.push(`${result.status.toUpperCase().padEnd(8)} ${result.id.padEnd(6)} ${result.detail}`);
  }
  return lines.join("\n");
}
