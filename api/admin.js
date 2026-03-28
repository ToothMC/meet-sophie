// api/admin.js — Admin Dashboard API
import { createClient } from '@supabase/supabase-js';
import { PLAN_PRICES } from '../lib/billing-constants.js';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function isAdmin(userId) {
  const ids = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

export default async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = getSupabase();
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  if (!isAdmin(user.id)) return res.status(403).json({ error: 'Forbidden' });

  const action = req.query?.action || '';

  // ── Overview: KPIs ──
  if (action === 'overview' && req.method === 'GET') {
    const today = new Date().toISOString().split('T')[0];
    const monthStart = today.slice(0, 8) + '01';
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

    const [subsRes, usageRes, costTodayRes, costWeekRes, costMonthRes, healthRes] = await Promise.all([
      supabase.from('user_subscriptions').select('plan, is_active, status'),
      supabase.from('user_usage').select('free_tokens_used, paid_tokens_used, topup_tokens_balance'),
      supabase.from('ai_cost_daily').select('total_cost').eq('date', today),
      supabase.from('ai_cost_daily').select('total_cost').gte('date', weekAgo),
      supabase.from('ai_cost_daily').select('total_cost').gte('date', monthStart),
      supabase.from('ai_provider_health').select('*'),
    ]);

    const subs = subsRes.data || [];
    const activeSubs = subs.filter(s => s.is_active || s.status === 'active' || s.status === 'trialing');
    const planCounts = { start: 0, plus: 0, premium: 0 };
    for (const s of activeSubs) {
      if (s.plan && planCounts[s.plan] !== undefined) planCounts[s.plan]++;
    }

    const mrr = Object.entries(planCounts).reduce((sum, [plan, count]) => sum + (PLAN_PRICES[plan] || 0) * count, 0);
    const totalUsers = subs.length;
    const freeUsers = totalUsers - activeSubs.length;

    const sumCost = (rows) => (rows || []).reduce((s, r) => s + (parseFloat(r.total_cost) || 0), 0);
    const costToday = sumCost(costTodayRes.data);
    const costWeek = sumCost(costWeekRes.data);
    const costMonth = sumCost(costMonthRes.data);

    // Provider health summary
    const providers = healthRes.data || [];
    const providersDown = providers.filter(p => p.status === 'down').length;
    const providersDegraded = providers.filter(p => p.status === 'degraded').length;

    // Alerts
    const alerts = [];
    if (providersDown > 0) alerts.push({ level: 'error', msg: `${providersDown} Provider down!` });
    if (providersDegraded > 0) alerts.push({ level: 'warn', msg: `${providersDegraded} Provider degraded` });
    if (mrr > 0 && costMonth > mrr * 0.8) alerts.push({ level: 'warn', msg: `AI-Kosten bei ${Math.round(costMonth / mrr * 100)}% des MRR` });
    if (costToday > 10) alerts.push({ level: 'warn', msg: `Hohe Tageskosten: $${costToday.toFixed(2)}` });

    return res.status(200).json({
      users: { total: totalUsers, active: activeSubs.length, free: freeUsers, plans: planCounts },
      revenue: { mrr: Math.round(mrr * 100) / 100 },
      costs: { today: costToday, week: costWeek, month: costMonth },
      margin: mrr > 0 ? Math.round((1 - costMonth / mrr) * 100) : null,
      providers: providers.map(p => ({ provider: p.provider, status: p.status, latency_ms: p.latency_ms, last_check: p.last_check, error: p.error })),
      alerts,
    });
  }

  // ── Costs: 30-day detail ──
  if (action === 'costs' && req.method === 'GET') {
    const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

    const { data: daily } = await supabase
      .from('ai_cost_daily')
      .select('date, total_cost, per_provider, request_count, user_id')
      .gte('date', thirtyAgo)
      .order('date', { ascending: true });

    // Aggregate per day
    const byDay = {};
    const providerTotals = {};
    const userCosts = {};

    for (const row of (daily || [])) {
      const d = row.date;
      if (!byDay[d]) byDay[d] = { date: d, cost: 0, requests: 0 };
      byDay[d].cost += parseFloat(row.total_cost) || 0;
      byDay[d].requests += row.request_count || 0;

      // Provider breakdown
      for (const [p, c] of Object.entries(row.per_provider || {})) {
        providerTotals[p] = (providerTotals[p] || 0) + (parseFloat(c) || 0);
      }

      // Per-user costs
      userCosts[row.user_id] = (userCosts[row.user_id] || 0) + (parseFloat(row.total_cost) || 0);
    }

    // Top users by cost
    const topUsers = Object.entries(userCosts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, cost]) => ({ user_id: id, cost }));

    // Resolve emails for top users
    if (topUsers.length) {
      const ids = topUsers.map(u => u.user_id);
      const { data: profiles } = await supabase
        .from('user_profile')
        .select('user_id, preferred_name, first_name')
        .in('user_id', ids);
      const { data: subs } = await supabase
        .from('user_subscriptions')
        .select('user_id, plan, is_active')
        .in('user_id', ids);

      const profMap = Object.fromEntries((profiles || []).map(p => [p.user_id, p]));
      const subMap = Object.fromEntries((subs || []).map(s => [s.user_id, s]));

      for (const u of topUsers) {
        u.name = profMap[u.user_id]?.preferred_name || profMap[u.user_id]?.first_name || u.user_id.slice(0, 8);
        u.plan = subMap[u.user_id]?.plan || 'free';
        u.active = subMap[u.user_id]?.is_active || false;
      }
    }

    return res.status(200).json({
      daily: Object.values(byDay),
      providers: providerTotals,
      topUsers,
    });
  }

  // ── Users: full list ──
  if (action === 'users' && req.method === 'GET') {
    const monthStart = new Date().toISOString().slice(0, 8) + '01';

    const [subsRes, usageRes, profRes, costRes] = await Promise.all([
      supabase.from('user_subscriptions').select('user_id, plan, is_active, status, current_period_end'),
      supabase.from('user_usage').select('user_id, free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance'),
      supabase.from('user_profile').select('user_id, preferred_name, first_name'),
      supabase.from('ai_cost_daily').select('user_id, total_cost').gte('date', monthStart),
    ]);

    const subMap = Object.fromEntries((subsRes.data || []).map(s => [s.user_id, s]));
    const usageMap = Object.fromEntries((usageRes.data || []).map(u => [u.user_id, u]));
    const profMap = Object.fromEntries((profRes.data || []).map(p => [p.user_id, p]));

    // Monthly costs per user
    const costMap = {};
    for (const c of (costRes.data || [])) {
      costMap[c.user_id] = (costMap[c.user_id] || 0) + (parseFloat(c.total_cost) || 0);
    }

    // Merge all user IDs
    const allIds = new Set([
      ...Object.keys(subMap),
      ...Object.keys(usageMap),
      ...Object.keys(profMap),
    ]);

    const users = [];
    for (const id of allIds) {
      const sub = subMap[id];
      const usage = usageMap[id];
      const prof = profMap[id];
      const freeRem = Math.max(0, (usage?.free_tokens_total ?? 50) - (usage?.free_tokens_used ?? 0));
      const paidRem = Math.max(0, (usage?.paid_tokens_total ?? 0) - (usage?.paid_tokens_used ?? 0));
      const topupRem = Math.max(0, usage?.topup_tokens_balance ?? 0);

      users.push({
        id,
        name: prof?.preferred_name || prof?.first_name || id.slice(0, 8),
        plan: sub?.plan || 'free',
        active: !!(sub?.is_active || sub?.status === 'active' || sub?.status === 'trialing'),
        remaining: freeRem + paidRem + topupRem,
        costMonth: costMap[id] || 0,
        periodEnd: sub?.current_period_end || null,
      });
    }

    users.sort((a, b) => b.costMonth - a.costMonth);

    return res.status(200).json({ users });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
