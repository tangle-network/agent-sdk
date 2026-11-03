/**
 * Lifecycle bounds a caller may place on one environment create (#309).
 *
 * Both are whole seconds — a millisecond value that is not a whole second is
 * refused, so a caller never believes a sub-second bound was honored. A
 * provider that cannot enforce a requested bound fails the create rather than
 * dropping the field; one whose platform caps the value honors the shorter.
 */
export interface AgentEnvironmentLifetime {
  /** Hard wall-clock lifetime the environment cannot outlive, counted from the create. */
  maxLifetimeMs?: number;
  /** After this long with no caller activity the platform may suspend or stop the environment. */
  idleTimeoutMs?: number;
}
