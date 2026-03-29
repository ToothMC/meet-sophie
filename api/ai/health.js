// api/ai/health.js — Health Check + Budget Monitor (Vercel Cron: every 60s)
// GET /api/ai/health → pings providers, checks budgets, detects anomalies
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../../lib/ai/adapters/index.js';

const PROVIDERS = ['openai', 'anthropic', 'google', 'mistral'];

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  // ── 1. Provider Health Checks ──
  const results = [];

  for (const provider of PROVIDERS) {
    const start = Date.now();
    try {
      const adapter = getAdapter(provider);
      const health = await adapter.healthCheck();
      results.push({
        provider,
        status: health.ok ? 'healthy' : 'degraded',
        latency_ms: health.latencyMs,
        last_check: new Date().toISOString(),
        error: null,
      });
    } catch (err) {
      const errMsg = err?.message?.slice(0, 500) || 'Unknown error';
      results.push({
        provider,
        status: 'down',
        latency_ms: Date.now() - start,
        last_check: new Date().toISOString(),
        error: errMsg,
      });
    }
  }

  await supabase.from('ai_provider_health').upsert(results, { onConflict: 'provider' });

  // ── 2. Budget Monitoring ──
  const alerts = [];
  try {
    // Load budget configs
    const { data: budgets } = await supabase.from('api_budget_alerts').select('*').eq('enabled', true);
    if (budgets?.length) {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = today.slice(0, 8) + '01';

      // Get today's costs per provider from ai_cost_daily
      const { data: todayCosts } = await supabase
        .from('ai_cost_daily')
        .select('per_provider, total_cost')
        .eq('date', today);

      // Aggregate per-provider daily costs across all users
      const dailyByProvider = {};
      let dailyTotal = 0;
      for (const row of (todayCosts || [])) {
        dailyTotal += Number(row.total_cost || 0);
        for (const [p, cost] of Object.entries(row.per_provider || {})) {
          dailyByProvider[p] = (dailyByProvider[p] || 0) + Number(cost || 0);
        }
      }

      // Get this month's costs per provider
      const { data: monthCosts } = await supabase
        .from('ai_cost_daily')
        .select('per_provider, total_cost')
        .gte('date', monthStart);

      const monthlyByProvider = {};
      let monthlyTotal = 0;
      for (const row of (monthCosts || [])) {
        monthlyTotal += Number(row.total_cost || 0);
        for (const [p, cost] of Object.entries(row.per_provider || {})) {
          monthlyByProvider[p] = (monthlyByProvider[p] || 0) + Number(cost || 0);
        }
      }

      // Check each provider budget
      for (const budget of budgets) {
        const p = budget.provider;
        const thresholdPct = budget.threshold_pct || 80;
        const dailyCost = p === 'all' ? dailyTotal : (dailyByProvider[p] || 0);
        const monthlyCost = p === 'all' ? monthlyTotal : (monthlyByProvider[p] || 0);

        // Daily budget check
        if (budget.daily_budget_usd && dailyCost > 0) {
          const pct = (dailyCost / Number(budget.daily_budget_usd)) * 100;
          if (pct >= 100) {
            alerts.push({ provider: p, alert_type: 'budget_daily', severity: 'critical',
              message: `${p.toUpperCase()} Tagesbudget überschritten: $${dailyCost.toFixed(2)} / $${budget.daily_budget_usd} (${Math.round(pct)}%)`,
              cost_at_alert: dailyCost, budget_limit: Number(budget.daily_budget_usd) });
          } else if (pct >= thresholdPct) {
            alerts.push({ provider: p, alert_type: 'budget_daily', severity: 'warn',
              message: `${p.toUpperCase()} Tagesbudget bei ${Math.round(pct)}%: $${dailyCost.toFixed(2)} / $${budget.daily_budget_usd}`,
              cost_at_alert: dailyCost, budget_limit: Number(budget.daily_budget_usd) });
          }
        }

        // Monthly budget check
        if (budget.monthly_budget_usd && monthlyCost > 0) {
          const pct = (monthlyCost / Number(budget.monthly_budget_usd)) * 100;
          if (pct >= 100) {
            alerts.push({ provider: p, alert_type: 'budget_monthly', severity: 'critical',
              message: `${p.toUpperCase()} Monatsbudget überschritten: $${monthlyCost.toFixed(2)} / $${budget.monthly_budget_usd} (${Math.round(pct)}%)`,
              cost_at_alert: monthlyCost, budget_limit: Number(budget.monthly_budget_usd) });
          } else if (pct >= thresholdPct) {
            alerts.push({ provider: p, alert_type: 'budget_monthly', severity: 'warn',
              message: `${p.toUpperCase()} Monatsbudget bei ${Math.round(pct)}%: $${monthlyCost.toFixed(2)} / $${budget.monthly_budget_usd}`,
              cost_at_alert: monthlyCost, budget_limit: Number(budget.monthly_budget_usd) });
          }
        }
      }

      // ── 3. Anomaly Detection: today vs. 7-day average ──
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const { data: weekCosts } = await supabase
        .from('ai_cost_daily')
        .select('date, total_cost, per_provider')
        .gte('date', sevenDaysAgo)
        .lt('date', today);

      if (weekCosts?.length >= 2) {
        // Per-provider 7-day average
        const avgByProvider = {};
        let totalAvg = 0;
        const days = weekCosts.length;
        for (const row of weekCosts) {
          totalAvg += Number(row.total_cost || 0);
          for (const [p, cost] of Object.entries(row.per_provider || {})) {
            avgByProvider[p] = (avgByProvider[p] || 0) + Number(cost || 0);
          }
        }
        totalAvg /= days;
        for (const p of Object.keys(avgByProvider)) avgByProvider[p] /= days;

        // Check if today's cost > 3× average
        if (dailyTotal > totalAvg * 3 && dailyTotal > 1) {
          alerts.push({ provider: 'all', alert_type: 'anomaly', severity: 'warn',
            message: `Ungewöhnlich hoher Verbrauch: $${dailyTotal.toFixed(2)} heute vs. $${totalAvg.toFixed(2)} Ø/Tag (${(dailyTotal / totalAvg).toFixed(1)}×)`,
            cost_at_alert: dailyTotal, budget_limit: totalAvg * 3 });
        }
        for (const p of PROVIDERS) {
          const avg = avgByProvider[p] || 0;
          const daily = dailyByProvider[p] || 0;
          if (daily > avg * 3 && daily > 0.5) {
            alerts.push({ provider: p, alert_type: 'anomaly', severity: 'warn',
              message: `${p.toUpperCase()} Anomalie: $${daily.toFixed(2)} heute vs. $${avg.toFixed(2)} Ø/Tag (${(daily / avg).toFixed(1)}×)`,
              cost_at_alert: daily, budget_limit: avg * 3 });
          }
        }
      }
    }

    // ── 4. Provider Down Alerts ──
    for (const r of results) {
      if (r.status === 'down') {
        alerts.push({ provider: r.provider, alert_type: 'provider_down', severity: 'critical',
          message: `${r.provider.toUpperCase()} ist DOWN: ${r.error || 'Keine Antwort'}`,
          cost_at_alert: 0, budget_limit: 0 });
      }
    }

    // Deduplicate: don't re-alert if same alert was created in last 30 minutes
    if (alerts.length) {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60000).toISOString();
      const { data: recentAlerts } = await supabase
        .from('api_alert_log')
        .select('provider, alert_type')
        .gte('created_at', thirtyMinAgo);

      const recentKeys = new Set((recentAlerts || []).map(a => `${a.provider}:${a.alert_type}`));
      const newAlerts = alerts.filter(a => !recentKeys.has(`${a.provider}:${a.alert_type}`));

      if (newAlerts.length) {
        await supabase.from('api_alert_log').insert(newAlerts);
        console.log(`[health] ${newAlerts.length} new alerts:`, newAlerts.map(a => a.message).join(' | '));

        // Webhook notification for critical alerts
        const criticals = newAlerts.filter(a => a.severity === 'critical');
        if (criticals.length && process.env.ALERT_WEBHOOK_URL) {
          try {
            await fetch(process.env.ALERT_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: `🚨 Sophie Alert: ${criticals.map(a => a.message).join(' | ')}`,
                alerts: criticals,
              }),
            });
          } catch (e) { console.error('[health] webhook failed:', e?.message); }
        }
      }
    }
  } catch (budgetErr) {
    console.error('[health] budget check failed:', budgetErr?.message);
  }

  return res.status(200).json({ results, alerts });
}
