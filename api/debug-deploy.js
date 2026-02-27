export default function handler(req, res) {
  res.status(200).json({
    vercel_env: process.env.VERCEL_ENV || null,
    git_branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    git_commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    price_starter_prefix: String(process.env.STRIPE_PRICE_ID_STARTER || "").slice(0, 6),
    price_starter_tail: String(process.env.STRIPE_PRICE_ID_STARTER || "").slice(-8),
  });
}
