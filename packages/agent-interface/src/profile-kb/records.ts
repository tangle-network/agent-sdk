import type { ProfileKbDiscrepancy, ProfileKbLearning } from "./types.js";

const CHECKED = "2026-09-22";

/**
 * Lessons this platform measured itself. A lesson enters only after an
 * agent-eval check reproduced it strongly; none has met that bar yet, so the
 * list is empty rather than filled with single-run observations.
 */
export const profileKbLearnings: readonly ProfileKbLearning[] = [];

/**
 * Historical naming and availability checks from 2026-09-22. Their dates and
 * observations are retained; they do not establish current service or identity.
 */
export const profileKbDiscrepancies: readonly ProfileKbDiscrepancy[] = [
  {
    subject: "OpenAI Codex models",
    requested: "gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna as the current Codex models",
    observed:
      "On 2026-09-22, OpenAI's Codex model page listed GPT-6 Astra, GPT-6 Sol, and GPT-6 Luna as current. " +
      "The check notes recorded OK replies for all three with codex-cli 0.156.1 on a ChatGPT account, and labelled the gpt-5.6 tiers 'Older'. " +
      "Those response checks did not establish served identity, task quality, or availability today.",
    sources: [
      { url: "https://learn.chatgpt.com/docs/models", checkedAt: CHECKED },
      {
        url: "cli:codex exec -m <model> 'Reply with exactly: OK'",
        checkedAt: CHECKED,
        note: "codex-cli 0.156.1",
      },
    ],
  },
  {
    subject: "DeepSeek V4.1 Pro",
    requested: "DeepSeek V4.1 Pro",
    observed:
      "The sources checked on 2026-09-22 documented V4.1 Flash, released 2026-09-10, but did not establish a V4.1 Pro model. " +
      "The changelog said the V4 Pro API continued; pricing mapped deepseek-v4-pro to DeepSeek-V4-Pro-0813, while the Flash announcement said it routed to V4.1 Flash from 2026-09-14. " +
      "The router check recorded HTTP 503 (provider quota exhausted) for deepseek-v4-pro; it did not resolve that source disagreement.",
    sources: [
      { url: "https://api-docs.deepseek.com/updates/", checkedAt: CHECKED },
      { url: "https://api-docs.deepseek.com/quick_start/pricing", checkedAt: CHECKED },
      { url: "https://api-docs.deepseek.com/news/news260910/", checkedAt: CHECKED },
    ],
  },
  {
    subject: "DeepSeek V4.1 Flash router id",
    requested: "deepseek-flash (the vendor id)",
    observed:
      "The 2026-09-22 Tangle router check recorded HTTP 503 (provider_pricing_unavailable) for deepseek-flash and HTTP 200 for deepseek/deepseek-v4.1-flash. " +
      "These statuses did not establish served identity or current availability.",
    sources: [
      {
        url: "https://router.tangle.tools/v1/chat/completions",
        checkedAt: CHECKED,
      },
    ],
  },
  {
    subject: "GPT-6 Pro",
    requested: "GPT-6 Pro in ChatGPT",
    observed:
      "The 2026-09-22 check recorded OpenAI's description of GPT-6 Pro as a ChatGPT mode powered by GPT-6 Astra. " +
      "That check did not establish a separate API model id for the ChatGPT mode.",
    sources: [
      {
        url: "https://help.openai.com/en/articles/20001354-gpt-56-and-gpt-6-pro-in-chatgpt",
        checkedAt: CHECKED,
      },
    ],
  },
];
