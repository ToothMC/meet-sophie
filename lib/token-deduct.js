// lib/token-deduct.js — shared token waterfall (free → paid → topup).
import { DEFAULT_FREE_TOKENS } from './billing-constants.js';

const USAGE_COLUMNS = 'free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance';

/**
 * Pure waterfall math. Returns the column updates to apply (without updated_at).
 * @param {{ free_tokens_total?: number, free_tokens_used?: number, paid_tokens_total?: number, paid_tokens_used?: number, topup_tokens_balance?: number }} usage
 * @param {number} amount
 */
export function computeTokenDeduction(usage, amount = 1) {
  const freeRem = Math.max(0, (usage?.free_tokens_total || 0) - (usage?.free_tokens_used || 0));
  const paidRem = Math.max(0, (usage?.paid_tokens_total || 0) - (usage?.paid_tokens_used || 0));
  const topupRem = Math.max(0, usage?.topup_tokens_balance || 0);
  const totalRem = freeRem + paidRem + topupRem;

  if (totalRem <= 0) return { ok: false, remaining: 0, exhausted: true, updates: null, uncovered: amount };

  let toDeduct = amount;
  const updates = {};
  if (toDeduct > 0 && freeRem > 0) {
    const fromFree = Math.min(toDeduct, freeRem);
    updates.free_tokens_used = (usage.free_tokens_used || 0) + fromFree;
    toDeduct -= fromFree;
  }
  if (toDeduct > 0 && paidRem > 0) {
    const fromPaid = Math.min(toDeduct, paidRem);
    updates.paid_tokens_used = (usage.paid_tokens_used || 0) + fromPaid;
    toDeduct -= fromPaid;
  }
  if (toDeduct > 0 && topupRem > 0) {
    const fromTopup = Math.min(toDeduct, topupRem);
    updates.topup_tokens_balance = (usage.topup_tokens_balance || 0) - fromTopup;
    toDeduct -= fromTopup;
  }
  const remaining = Math.max(0, totalRem - amount + toDeduct);
  return { ok: true, remaining, exhausted: remaining <= 0, updates, uncovered: toDeduct };
}

/**
 * Deducts `amount` tokens for `userId`, creating the usage row if missing.
 * @returns {Promise<{ ok: boolean, remaining: number, exhausted: boolean }>}
 */
export async function deductTokens(supabase, userId, amount = 1) {
  let { data: usage } = await supabase
    .from('user_usage')
    .select(USAGE_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (!usage) {
    const { data: created } = await supabase
      .from('user_usage')
      .upsert({
        user_id: userId,
        free_tokens_total: DEFAULT_FREE_TOKENS, free_tokens_used: 0,
        paid_tokens_total: 0, paid_tokens_used: 0, topup_tokens_balance: 0,
      }, { onConflict: 'user_id' })
      .select(USAGE_COLUMNS)
      .single();
    if (!created) return { ok: false, remaining: 0, exhausted: true };
    usage = created;
  }

  const result = computeTokenDeduction(usage, amount);
  if (!result.ok) return { ok: false, remaining: 0, exhausted: true };

  await supabase
    .from('user_usage')
    .update({ ...result.updates, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  return { ok: true, remaining: result.remaining, exhausted: result.exhausted };
}
