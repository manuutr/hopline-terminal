/** The chat assistant's per-run token budget (input-equivalent tokens, metered by fleet/budget.ts). */
export const DEFAULT_RUN_TOKEN_BUDGET = 200_000
/**
 * At least 20k (review L1): every turn reserves OUTPUT_RESERVE × OUTPUT_WEIGHT = 5,000 tokens for
 * its answer before it is sent, so a 5k budget closed the run before its first turn.
 */
export const MIN_RUN_TOKEN_BUDGET = 20_000
export const MAX_RUN_TOKEN_BUDGET = 4_000_000

/**
 * Why a run cannot start: its first turn (the conversation so far, with room for the answer) does
 * not fit the whole budget. Below MIN_RUN_TOKEN_BUDGET only a team policy cap can be the reason
 * (the policy file accepts 5k), so that case points at the policy, not at a setting the user
 * cannot raise.
 */
export function firstTurnTooLargeMessage(estimate: number, budget: number): string {
  const k = (n: number) => `${Math.max(1, Math.round(n / 1000))}k`
  if (budget < MIN_RUN_TOKEN_BUDGET)
    return `The team policy caps a run at ${k(budget)} tokens, which is too small for this question: its first turn needs about ${k(estimate)} with room for the answer. Ask whoever manages the policy to raise maxRunTokenBudget to at least ${k(MIN_RUN_TOKEN_BUDGET)}.`
  return `This conversation is too long for the run's token budget: its first turn needs about ${k(estimate)} tokens with room for the answer, and the budget is ${k(budget)}. Start a new conversation, or raise the budget in Settings › Assistant.`
}

/** A usable budget: the default for junk, within the bounds, and never above the policy's cap. */
export function clampRunBudget(n: number | undefined, policyMax?: number | null): number {
  const v = Math.floor(Number(n))
  const b = !Number.isFinite(v) || v <= 0 ? DEFAULT_RUN_TOKEN_BUDGET : Math.min(Math.max(v, MIN_RUN_TOKEN_BUDGET), MAX_RUN_TOKEN_BUDGET)
  return policyMax ? Math.min(b, policyMax) : b
}
