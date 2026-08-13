import { join } from "node:path";
import {
  interfaceTests,
  prepareControlCohort,
  run,
  tangleFixtureTest,
  testkitTest,
  tsc,
  vitest,
} from "./lib/control-cohort.mjs";

const cohort = prepareControlCohort();
try {
  run(tsc, ["-p", "tsconfig.json"], { cwd: cohort.consumer });
  const testOutput = run(
    vitest,
    [
      "run",
      ...interfaceTests,
      testkitTest,
      tangleFixtureTest,
      "--root",
      cohort.consumer,
      "--config",
      join(cohort.consumer, "vitest.config.mjs"),
    ],
    { cwd: cohort.consumer },
  );
  const testSummary = testOutput
    .split("\n")
    .filter((line) => /Test Files|Tests\s+\d+ passed/.test(line.trim()))
    .map((line) => line.trim())
    .join("; ");
  console.log(
    `Packed control contracts passed: ${cohort.packageVersions.join(", ")}; ${testSummary}`,
  );
} finally {
  cohort.cleanup();
}
