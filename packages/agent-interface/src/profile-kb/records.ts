import type { ProfileKbDiscrepancy, ProfileKbLearning } from "./types.js";

const CHECKED = "2026-09-22";

/**
 * Lessons this platform measured itself. A lesson enters only after an
 * agent-eval check reproduced it strongly; none has met that bar yet, so the
 * list is empty rather than filled with single-run observations.
 */
export const profileKbLearnings: readonly ProfileKbLearning[] = [];

/**
 * Names the platform asked for that vendor sources state differently, as read
 * on 2026-09-22. Recorded instead of guessed.
 */
export const profileKbDiscrepancies: readonly ProfileKbDiscrepancy[] = [
  {
    subject: "OpenAI Codex models",
    requested: "gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna as the current Codex models",
    observed:
      "OpenAI's Codex model page lists GPT-6 Astra, GPT-6 Sol, and GPT-6 Luna as the current recommended models. " +
      "On this box, codex-cli 0.152.1 on a ChatGPT account serves gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna (each returned OK) " +
      "and labels them 'Older'; gpt-6-sol and gpt-6-luna return 'not supported when using Codex with a ChatGPT account', " +
      "and gpt-6-astra returns 'requires a newer version of Codex'. The knowledge base keeps the gpt-5.6 tiers because they are what this box can run.",
    sources: [
      { url: "https://learn.chatgpt.com/docs/models", checkedAt: CHECKED },
      {
        url: "cli:codex exec -m <model> 'Reply with exactly: OK'",
        checkedAt: CHECKED,
      },
    ],
  },
  {
    subject: "DeepSeek V4.1 Pro",
    requested: "DeepSeek V4.1 Pro",
    observed:
      "DeepSeek has released V4.1 Flash only (2026-09-10). Its changelog says the V4 Pro API continues, its pricing page maps " +
      "deepseek-v4-pro to DeepSeek-V4-Pro-0813, and its V4.1 Flash announcement says deepseek-v4-pro routes to V4.1 Flash from 2026-09-14. " +
      "On the Tangle router, deepseek-v4-pro returned HTTP 503 (provider quota exhausted). No V4.1 Pro entry exists until DeepSeek ships it.",
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
      "On the Tangle router, deepseek-flash returned HTTP 503 (provider_pricing_unavailable); deepseek/deepseek-v4.1-flash returned HTTP 200.",
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
      "OpenAI's help center names GPT-6 Pro as a ChatGPT mode powered by GPT-6 Astra; it has no API model id.",
    sources: [
      {
        url: "https://help.openai.com/en/articles/20001354-gpt-56-and-gpt-6-pro-in-chatgpt",
        checkedAt: CHECKED,
      },
    ],
  },
];
