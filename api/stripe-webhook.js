import Stripe from "stripe";
import { buffer } from "micro";
import { createClient } from "@supabase/supabase-js";
import {
  DEFAULT_FREE_TOKENS,
  includedTokensForPlan,
  topupTokensForPack,
  planFromPriceId,
} from "../lib/billing-constants.js";

export const config = { api: { bodyParser: false } };

async function safeTrack(supabase, userId, event_name, meta = {}) {
  try {
    if (!userId) return;
    await supabase.from("analytics_events").insert({
      user_id: userId,
      event_name,
      meta,
    });
  } catch (e) {
    console.warn("Analytics insert failed:", e?.message || e);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!webhookSecret) return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");
  if (!stripeKey) return res.status(500).send("Missing STRIPE_SECRET_KEY");

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).send("Missing Supabase server env vars");

  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
  const supabase = createClient(supabaseUrl, serviceKey);

  let event;
  try {
    const rawBody = await buffer(req);
    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).send("Missing stripe-signature header");
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    console.log("Stripe event received:", { type: event.type, id: event.id });

    // Idempotency: skip already-processed events (Stripe can deliver webhooks multiple times)
    const { data: existingEvent } = await supabase
      .from("analytics_events")
      .select("id")
      .eq("event_name", "stripe_webhook_" + event.type)
      .eq("meta->>stripe_event_id", event.id)
      .maybeSingle();

    if (existingEvent) {
      console.log("Webhook already processed, skipping:", event.id);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Mark this event as processed BEFORE doing anything (prevents race with parallel deliveries)
    const eventUserId = event.data?.object?.metadata?.user_id || null;
    await supabase.from("analytics_events").insert({
      user_id: eventUserId,
      event_name: "stripe_webhook_" + event.type,
      meta: { stripe_event_id: event.id, event_type: event.type },
    }).catch(() => {}); // don't block on analytics failure

    // 1) Checkout completed
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session?.metadata?.user_id;
      if (!userId) {
        console.warn("checkout.session.completed without metadata.user_id");
        return res.status(200).json({ received: true });
      }

      const mode = session?.mode; // "subscription" | "payment"
      const stripeCustomerId = session?.customer || null;

      // Atomic idempotency claim — prevents double-grant when /api/billing?action=confirm
      // and this webhook race on the same checkout.session. Only the winner of the
      // INSERT writes user_usage/user_subscriptions.
      const { error: claimErr } = await supabase
        .from("billing_processed_sessions")
        .insert({ stripe_session_id: session.id, processed_by: "webhook", user_id: userId, mode });
      if (claimErr?.code === "23505") {
        console.log("[webhook] Session already processed by confirm, skipping:", session.id);
        return res.status(200).json({ received: true, already_processed: true });
      }
      if (claimErr) {
        console.error("[webhook] Idempotency claim failed:", claimErr);
        return res.status(500).send("Idempotency check failed");
      }

      // A) Subscription
      if (mode === "subscription") {
        const stripeSubscriptionId = session?.subscription || null;

        let plan = String(session?.metadata?.plan || "").toLowerCase().trim();

        // Resolve plan from Stripe subscription if not in metadata
        let subObj = null;
        if ((!plan || plan === "0") && stripeSubscriptionId) {
          try {
            subObj = await stripe.subscriptions.retrieve(stripeSubscriptionId);
            plan = String(subObj?.metadata?.plan || "").toLowerCase().trim();

            if (!plan || plan === "0") {
              const item = subObj?.items?.data?.[0];
              const priceId = item?.price?.id || "";
              plan = planFromPriceId(priceId);
            }
          } catch (e) {
            console.warn("Plan fallback failed:", e?.message || e);
          }
        }

        // Fetch subscription object for trial info if not already fetched
        if (!subObj && stripeSubscriptionId) {
          try { subObj = await stripe.subscriptions.retrieve(stripeSubscriptionId); } catch {}
        }

        const includedTokens = includedTokensForPlan(plan);

        if (!includedTokens) {
          console.error("No included tokens resolved - refusing activation", {
            userId,
            plan,
            stripeSubscriptionId,
          });
          await safeTrack(supabase, userId, "subscription_activation_failed", {
            plan: plan || null,
            stripe_subscription_id: stripeSubscriptionId,
            reason: "no_included_tokens",
          });
          return res.status(500).send("No included tokens resolved");
        }

        // Extract trial info from Stripe subscription
        const subStatus = subObj?.status || "active";
        const isTrialing = subStatus === "trialing";
        const trialEnd = subObj?.trial_end
          ? new Date(subObj.trial_end * 1000).toISOString()
          : null;
        const currentPeriodEnd = subObj?.current_period_end
          ? new Date(subObj.current_period_end * 1000).toISOString()
          : null;

        const { error: subErr } = await supabase
          .from("user_subscriptions")
          .upsert(
            {
              user_id: userId,
              stripe_customer_id: stripeCustomerId,
              stripe_subscription_id: stripeSubscriptionId,
              status: subStatus,
              is_active: true,
              plan: plan || null,
              current_period_end: currentPeriodEnd,
              trial_end: trialEnd,
              trial_started_at: isTrialing ? new Date().toISOString() : null,
              cancel_at_period_end: false,
            },
            { onConflict: "user_id" }
          );

        if (subErr) {
          console.error("Supabase upsert user_subscriptions failed:", subErr);
          return res.status(500).send("Supabase write failed (user_subscriptions)");
        }

        // usage row upsert-ish
        const { data: usage, error: uFindErr } = await supabase
          .from("user_usage")
          .select("user_id")
          .eq("user_id", userId)
          .maybeSingle();

        if (uFindErr) {
          console.error("Supabase select user_usage failed:", uFindErr);
          return res.status(500).send("Supabase read failed (user_usage)");
        }

        if (!usage) {
          const { error: uInsErr } = await supabase.from("user_usage").insert({
            user_id: userId,
            free_tokens_total: DEFAULT_FREE_TOKENS,
            free_tokens_used: 0,
            paid_tokens_total: includedTokens,
            paid_tokens_used: 0,
            topup_tokens_balance: 0,
          });
          if (uInsErr) {
            console.error("Supabase insert user_usage failed:", uInsErr);
            return res.status(500).send("Supabase write failed (user_usage insert)");
          }
        } else {
          // Carry over remaining paid tokens as topup balance (upgrade fairness)
          const { data: currentUsage } = await supabase
            .from("user_usage")
            .select("paid_tokens_total, paid_tokens_used, topup_tokens_balance")
            .eq("user_id", userId)
            .maybeSingle();

          const paidRemaining = Math.max(0, (currentUsage?.paid_tokens_total || 0) - (currentUsage?.paid_tokens_used || 0));
          const topupCarryover = paidRemaining > 0 ? paidRemaining : 0;
          const newTopupBalance = (currentUsage?.topup_tokens_balance || 0) + topupCarryover;

          if (topupCarryover > 0) {
            console.log(`[webhook] Upgrade: carrying over ${topupCarryover} remaining paid tokens as topup for user ${userId.slice(0, 8)}`);
          }

          const { error: uUpdErr } = await supabase
            .from("user_usage")
            .update({
              free_tokens_total: 0,
              free_tokens_used: 0,
              paid_tokens_total: includedTokens,
              paid_tokens_used: 0,
              topup_tokens_balance: newTopupBalance,
            })
            .eq("user_id", userId);

          if (uUpdErr) {
            console.error("Supabase update user_usage failed:", uUpdErr);
            return res.status(500).send("Supabase write failed (user_usage update)");
          }
        }

        await safeTrack(supabase, userId, "subscription_activated", {
          plan: plan || null,
          stripe_subscription_id: stripeSubscriptionId,
          stripe_customer_id: stripeCustomerId,
          included_tokens: includedTokens,
        });

        // Track trial_start event for trial subscriptions
        if (isTrialing) {
          await safeTrack(supabase, userId, "trial_start", {
            plan: plan || null,
            trial_end: trialEnd,
            stripe_subscription_id: stripeSubscriptionId,
          });
        }

        return res.status(200).json({ received: true });
      }

      // B) Top-up payment
      if (mode === "payment") {
        const pack = session?.metadata?.topup_pack;
        const addTokens = topupTokensForPack(pack);

        if (addTokens <= 0) {
          await safeTrack(supabase, userId, "topup_invalid_pack", { pack });
          return res.status(200).json({ received: true });
        }

        const { data: usage, error: uSelErr } = await supabase
          .from("user_usage")
          .select("topup_tokens_balance")
          .eq("user_id", userId)
          .maybeSingle();

        if (uSelErr) return res.status(500).send("Supabase read failed (user_usage)");

        if (!usage) {
          const { error: uInsErr } = await supabase.from("user_usage").insert({
            user_id: userId,
            free_tokens_total: DEFAULT_FREE_TOKENS,
            free_tokens_used: DEFAULT_FREE_TOKENS,
            paid_tokens_total: 0,
            paid_tokens_used: 0,
            topup_tokens_balance: addTokens,
          });
          if (uInsErr) return res.status(500).send("Supabase write failed (user_usage insert)");
        } else {
          const newBal = (usage.topup_tokens_balance || 0) + addTokens;
          const { error: uUpdErr } = await supabase
            .from("user_usage")
            .update({ free_tokens_total: 0, free_tokens_used: 0, topup_tokens_balance: newBal })
            .eq("user_id", userId);

          if (uUpdErr) return res.status(500).send("Supabase write failed (user_usage update)");
        }

        await safeTrack(supabase, userId, "topup_completed", {
          pack: Number(pack),
          added_tokens: addTokens,
          stripe_customer_id: stripeCustomerId,
        });

        return res.status(200).json({ received: true });
      }

      return res.status(200).json({ received: true });
    }

    // 2) Subscription Updated -> status/period_end sync + plan change detection
    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const stripeSubscriptionId = sub.id;
      const status = sub.status || null;
      const isActive = status === "active" || status === "trialing";
      const currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;
      const trialEnd = sub.trial_end
        ? new Date(sub.trial_end * 1000).toISOString()
        : null;
      const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

      const { data: row, error: findErr } = await supabase
        .from("user_subscriptions")
        .select("user_id, plan, trial_end")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

      if (findErr) return res.status(500).send("Supabase read failed (user_subscriptions)");
      if (!row?.user_id) return res.status(200).json({ received: true });

      const userId = row.user_id;

      // Detect plan change via price ID
      const newPriceId = sub.items?.data?.[0]?.price?.id || null;
      const newPlan = newPriceId ? planFromPriceId(newPriceId) : null;

      const updateFields = {
        status,
        is_active: isActive,
        current_period_end: currentPeriodEnd,
        trial_end: trialEnd,
        cancel_at_period_end: cancelAtPeriodEnd,
      };

      // If plan changed (e.g. via Stripe portal), update plan name and tokens
      if (newPlan && newPlan !== row.plan) {
        updateFields.plan = newPlan;
        console.log(`[webhook] Plan change detected: ${row.plan} → ${newPlan} for user ${userId.slice(0, 8)}`);
      }

      const { error: updErr } = await supabase
        .from("user_subscriptions")
        .update(updateFields)
        .eq("user_id", userId);

      if (updErr) return res.status(500).send("Supabase write failed (user_subscriptions)");

      // Track trial_cancel: user canceled while still in trial
      if (cancelAtPeriodEnd && row.trial_end) {
        const trialEndDate = new Date(row.trial_end);
        if (trialEndDate > new Date()) {
          await safeTrack(supabase, userId, "trial_cancel", {
            stripe_subscription_id: stripeSubscriptionId,
            trial_end: row.trial_end,
          });
        }
      }

      // If plan changed, adjust token allocation (carry over remaining as topup)
      if (newPlan && newPlan !== row.plan) {
        const newTokens = includedTokensForPlan(newPlan);
        if (newTokens > 0) {
          const { data: usage } = await supabase
            .from("user_usage")
            .select("paid_tokens_total, paid_tokens_used, topup_tokens_balance")
            .eq("user_id", userId)
            .maybeSingle();

          if (usage) {
            const paidRem = Math.max(0, (usage.paid_tokens_total || 0) - (usage.paid_tokens_used || 0));
            const newTopup = (usage.topup_tokens_balance || 0) + paidRem;

            await supabase.from("user_usage").update({
              paid_tokens_total: newTokens,
              paid_tokens_used: 0,
              topup_tokens_balance: newTopup,
            }).eq("user_id", userId);

            console.log(`[webhook] Tokens adjusted: ${usage.paid_tokens_total}→${newTokens}, carried over ${paidRem} as topup`);
          }
        }
      }

      await safeTrack(supabase, userId, "subscription_updated", {
        status,
        is_active: isActive,
        current_period_end: currentPeriodEnd,
        trial_end: trialEnd,
        cancel_at_period_end: cancelAtPeriodEnd,
        stripe_subscription_id: stripeSubscriptionId,
        plan_changed: newPlan && newPlan !== row.plan ? `${row.plan}→${newPlan}` : null,
      });

      return res.status(200).json({ received: true });
    }

    // 3) Monthly renew -> reset tokens
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;

      // only for subscription renewals
      if (invoice?.billing_reason !== "subscription_cycle") {
        return res.status(200).json({ received: true });
      }

      const stripeSubscriptionId = invoice?.subscription || null;
      if (!stripeSubscriptionId) return res.status(200).json({ received: true });

      const { data: row, error: findErr } = await supabase
        .from("user_subscriptions")
        .select("user_id, plan, is_active, trial_started_at")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

      if (findErr) return res.status(500).send("Supabase read failed (user_subscriptions)");
      if (!row?.user_id) return res.status(200).json({ received: true });
      if (!row.is_active) return res.status(200).json({ received: true });

      const userId = row.user_id;
      const includedTokens = includedTokensForPlan(row.plan);

      if (!includedTokens) return res.status(200).json({ received: true });

      const { error: uUpdErr } = await supabase
        .from("user_usage")
        .update({
          paid_tokens_total: includedTokens,
          paid_tokens_used: 0,
        })
        .eq("user_id", userId);

      if (uUpdErr) return res.status(500).send("Supabase write failed (user_usage reset)");

      await safeTrack(supabase, userId, "subscription_renewed", {
        stripe_subscription_id: stripeSubscriptionId,
        included_tokens: includedTokens,
      });

      // Track trial_convert: first real payment after a trial period
      if (row.trial_started_at) {
        await safeTrack(supabase, userId, "trial_convert", {
          stripe_subscription_id: stripeSubscriptionId,
          plan: row.plan,
          trial_started_at: row.trial_started_at,
        });
        // Clear trial fields now that user has converted
        await supabase.from("user_subscriptions").update({
          trial_end: null,
          trial_started_at: null,
        }).eq("user_id", userId);
      }

      return res.status(200).json({ received: true });
    }

    // 4) Subscription Deleted -> deactivate
    // Stripe fires this AFTER cancel_at_period_end has run out, so the user
    // has already paid for the period. Existing paid_tokens stay until they
    // expire naturally or get overwritten by a new checkout. Nulling them
    // here would void tokens the user already paid for.
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const stripeSubscriptionId = sub.id;

      const { data: row, error: findErr } = await supabase
        .from("user_subscriptions")
        .select("user_id, trial_started_at")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

      if (findErr) return res.status(500).send("Supabase read failed (user_subscriptions)");
      if (!row?.user_id) return res.status(200).json({ received: true });

      const userId = row.user_id;

      const { error: updErr } = await supabase
        .from("user_subscriptions")
        .update({
          status: "canceled",
          is_active: false,
          current_period_end: null,
          trial_end: null,
          cancel_at_period_end: false,
        })
        .eq("user_id", userId);

      if (updErr) return res.status(500).send("Supabase write failed (user_subscriptions)");

      await safeTrack(supabase, userId, "subscription_deleted", {
        stripe_subscription_id: stripeSubscriptionId,
      });

      // Track churn_month_1: canceled within 60 days of trial start
      if (row.trial_started_at) {
        const daysSinceTrialStart = (Date.now() - new Date(row.trial_started_at).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceTrialStart <= 60) {
          await safeTrack(supabase, userId, "churn_month_1", {
            stripe_subscription_id: stripeSubscriptionId,
            days_since_trial_start: Math.round(daysSinceTrialStart),
          });
        }
      }

      return res.status(200).json({ received: true });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handling error:", err);
    return res.status(500).send("Webhook handler failed");
  }
}
