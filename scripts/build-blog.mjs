import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Marked } from "marked";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const POSTS_DIR = path.join(ROOT, "blog", "posts");
const OUTPUT_DIR = path.join(ROOT, "blog");
const SITEMAP_PATH = path.join(ROOT, "sitemap.xml");
const SITE_URL = "https://www.meet-sophie.com";

const md = new Marked();

// ── Static pages for sitemap (non-blog) ──────────────────────────
const STATIC_PAGES = [
  { loc: "/", changefreq: "weekly", priority: "1.0" },
  { loc: "/pricing", changefreq: "monthly", priority: "0.8" },
  { loc: "/impressum.html", changefreq: "yearly", priority: "0.3" },
  { loc: "/privacy.html", changefreq: "yearly", priority: "0.3" },
  { loc: "/terms.html", changefreq: "yearly", priority: "0.3" },
  { loc: "/withdrawal.html", changefreq: "yearly", priority: "0.2" },
];

// ── Read & parse all posts ───────────────────────────────────────
function readPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith(".md"));
  const posts = files.map(file => {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), "utf-8");
    const { data, content } = matter(raw);
    const required = ["title", "description", "date", "slug", "lang"];
    for (const key of required) {
      if (!data[key]) throw new Error(`Missing frontmatter "${key}" in ${file}`);
    }
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const readingTime = Math.ceil(wordCount / 200);
    return {
      ...data,
      date: new Date(data.date).toISOString().split("T")[0],
      lastmod: data.lastmod ? new Date(data.lastmod).toISOString().split("T")[0] : null,
      body: md.parse(content),
      readingTime,
      file,
    };
  });
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}

// ── Date formatting ──────────────────────────────────────────────
function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// ── HTML Shell ───────────────────────────────────────────────────
function htmlShell({ title, description, canonical, ogType, image, lang, jsonLd, cssExtra, body }) {
  const img = image || `${SITE_URL}/hero.jpg`;
  return `<!doctype html>
<html lang="${lang || "en"}">
<head>
  <meta charset="utf-8">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="icon" href="/favicon.ico">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#06070b">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="${canonical}">

  <meta property="og:type" content="${ogType || "website"}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${img}">
  <meta property="og:locale" content="en_US">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${img}">

${jsonLd.map(j => `  <script type="application/ld+json">\n  ${JSON.stringify(j, null, 2).split("\n").join("\n  ")}\n  </script>`).join("\n")}

  <style>
    :root{
      --bg:#06070b;--bg-soft:#0d1018;
      --card:rgba(255,255,255,.06);--card-strong:rgba(255,255,255,.09);
      --text:#f6f7fb;--muted:rgba(246,247,251,.74);
      --line:rgba(255,255,255,.12);--accent:#ffffff;
      --shadow:0 18px 60px rgba(0,0,0,.35);--radius:24px;--max:1180px;
    }
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    html{scroll-behavior:smooth}
    body{
      margin:0;
      padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",Inter,system-ui,sans-serif;
      background-color:#06070b;
      background-image:
        radial-gradient(circle at top right,rgba(132,148,255,.14),transparent 28%),
        radial-gradient(circle at top left,rgba(255,199,146,.10),transparent 24%),
        linear-gradient(180deg,#090b11 0%,#06070b 42%,#090b11 100%);
      color:var(--text);line-height:1.5;
      -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
    }
    img{max-width:100%;display:block}
    a{color:inherit}
    .wrap{width:min(calc(100% - 32px),var(--max));margin:0 auto}

    /* Header */
    .site-header{position:sticky;top:0;z-index:40;backdrop-filter:blur(16px);background:rgba(6,7,11,.55);border-bottom:1px solid rgba(255,255,255,.06)}
    .nav{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:72px}
    .brand{font-size:15px;font-weight:700;letter-spacing:.01em;text-decoration:none;opacity:.94}
    .nav-right{display:flex;align-items:center;gap:18px}
    .nav-links{display:flex;align-items:center;gap:22px}
    .nav-links a{text-decoration:none;color:var(--muted);font-size:14px}
    .nav-links a:hover{color:var(--text)}
    .login-link{text-decoration:none;font-size:14px;font-weight:600;color:var(--text);border:1px solid rgba(255,255,255,.12);padding:10px 18px;border-radius:999px;background:rgba(255,255,255,.04);transition:transform .18s ease,background .18s ease}
    .login-link:hover{transform:translateY(-1px);background:rgba(255,255,255,.08)}

    /* Footer */
    .site-footer{border-top:1px solid rgba(255,255,255,.08);padding:26px 0 36px;background:rgba(0,0,0,.20)}
    .footer-row{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap}
    .footer-links{display:flex;gap:18px;flex-wrap:wrap}
    .footer-links a,.footer-brand{text-decoration:none;color:rgba(246,247,251,.66);font-size:14px}
    .footer-links a:hover{color:var(--text)}

    ${cssExtra || ""}

    @media(max-width:640px){
      .nav-links{display:none}
      .article{padding:32px 0}
      .article h1{font-size:26px}
      .listing-grid{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="wrap nav">
      <a class="brand" href="/">meet-sophie.com</a>
      <div class="nav-right">
        <nav class="nav-links" aria-label="Primary">
          <a href="/blog/">Blog</a>
          <a href="/#pricing">Pricing</a>
          <a href="/#trust">Trust</a>
        </nav>
        <a class="login-link" href="/login/">Log in</a>
      </div>
    </div>
  </header>

  <main>${body}</main>

  <footer class="site-footer">
    <div class="wrap footer-row">
      <a class="footer-brand" href="/">meet-sophie.com</a>
      <div class="footer-links">
        <a href="/blog/">Blog</a>
        <a href="/impressum.html">Impressum</a>
        <a href="/privacy.html">Privacy</a>
        <a href="/terms.html">Terms</a>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

// ── Article page ─────────────────────────────────────────────────
function renderArticle(post) {
  const canonical = `${SITE_URL}/blog/${post.slug}`;
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      dateModified: post.lastmod || post.date,
      author: { "@type": "Organization", name: "Meet Sophie", url: SITE_URL },
      publisher: { "@type": "Organization", name: "Meet Sophie", url: SITE_URL },
      mainEntityOfPage: canonical,
      image: post.image || `${SITE_URL}/hero.jpg`,
      keywords: (post.keywords || []).join(", "),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog/` },
        { "@type": "ListItem", position: 3, name: post.title },
      ],
    },
  ];

  const cssExtra = `
    .article{max-width:740px;margin:0 auto;padding:48px 0 64px}
    .article h1{font-size:36px;font-weight:700;letter-spacing:-.03em;line-height:1.2;margin-bottom:16px}
    .article-meta{color:var(--muted);font-size:14px;margin-bottom:40px;padding-bottom:24px;border-bottom:1px solid var(--line)}
    .article-body{font-size:17px;line-height:1.75;color:rgba(246,247,251,.88)}
    .article-body h2{font-size:24px;font-weight:600;margin:48px 0 16px;letter-spacing:-.02em;color:var(--text)}
    .article-body h3{font-size:20px;font-weight:600;margin:36px 0 12px;color:var(--text)}
    .article-body p{margin:0 0 20px}
    .article-body ul,.article-body ol{margin:0 0 20px;padding-left:24px}
    .article-body li{margin-bottom:8px}
    .article-body blockquote{border-left:3px solid var(--line);margin:24px 0;padding:4px 0 4px 20px;color:var(--muted);font-style:italic}
    .article-body a{text-decoration:underline;text-underline-offset:3px}
    .article-body a:hover{color:var(--accent)}
    .article-body code{background:var(--card);padding:2px 6px;border-radius:4px;font-size:15px}
    .article-body pre{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;overflow-x:auto;margin:24px 0}
    .article-body pre code{background:none;padding:0}
    .article-body img{border-radius:12px;margin:24px 0}
    .article-back{display:inline-block;margin-top:48px;color:var(--muted);text-decoration:none;font-size:14px}
    .article-back:hover{color:var(--text)}
    .breadcrumb{font-size:13px;color:var(--muted);margin-bottom:24px}
    .breadcrumb a{text-decoration:none;color:var(--muted)}
    .breadcrumb a:hover{color:var(--text)}
  `;

  const body = `
    <div class="wrap article">
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <a href="/">Home</a> &rsaquo; <a href="/blog/">Blog</a> &rsaquo; ${post.title}
      </nav>
      <h1>${post.title}</h1>
      <div class="article-meta">${formatDate(post.date)} &middot; ${post.readingTime} min read</div>
      <div class="article-body">${post.body}</div>
      <a class="article-back" href="/blog/">&larr; All articles</a>
    </div>
  `;

  return htmlShell({
    title: `${post.title} — Meet Sophie`,
    description: post.description,
    canonical,
    ogType: "article",
    image: post.image,
    lang: post.lang,
    jsonLd,
    cssExtra,
    body,
  });
}

// ── Listing page ─────────────────────────────────────────────────
function renderListing(posts) {
  const canonical = `${SITE_URL}/blog/`;
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Blog" },
      ],
    },
  ];

  const cssExtra = `
    .listing{max-width:840px;margin:0 auto;padding:48px 0 64px}
    .listing h1{font-size:32px;font-weight:700;letter-spacing:-.03em;margin-bottom:8px}
    .listing-intro{color:var(--muted);font-size:15px;margin-bottom:40px;line-height:1.6}
    .listing-grid{display:grid;grid-template-columns:1fr;gap:16px}
    .post-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;transition:background .2s,border-color .2s;text-decoration:none;display:block}
    .post-card:hover{background:var(--card-strong);border-color:rgba(255,255,255,.18)}
    .post-card h2{font-size:20px;font-weight:600;margin-bottom:8px;letter-spacing:-.02em;line-height:1.3}
    .post-card p{font-size:14px;color:var(--muted);line-height:1.6;margin-bottom:12px}
    .post-card .meta{font-size:13px;color:rgba(246,247,251,.5)}
  `;

  const cards = posts.map(p => `
    <a class="post-card" href="/blog/${p.slug}/">
      <h2>${p.title}</h2>
      <p>${p.description}</p>
      <span class="meta">${formatDate(p.date)} &middot; ${p.readingTime} min read</span>
    </a>
  `).join("");

  const body = `
    <div class="wrap listing">
      <h1>Blog</h1>
      <p class="listing-intro">Ideas on thinking, decisions, and working with AI.</p>
      <div class="listing-grid">${cards}</div>
    </div>
  `;

  return htmlShell({
    title: "Blog — Meet Sophie",
    description: "Articles on AI thinking partners, decision-making, meetings, and voice AI for professionals.",
    canonical,
    lang: "en",
    jsonLd,
    cssExtra,
    body,
  });
}

// ── Sitemap generation ───────────────────────────────────────────
function buildSitemap(posts) {
  const urls = [];

  // Static pages
  for (const page of STATIC_PAGES) {
    let entry = `  <url>\n    <loc>${SITE_URL}${page.loc}</loc>`;
    if (page.lastmod) entry += `\n    <lastmod>${page.lastmod}</lastmod>`;
    entry += `\n    <changefreq>${page.changefreq}</changefreq>`;
    entry += `\n    <priority>${page.priority}</priority>`;
    entry += `\n  </url>`;
    urls.push(entry);
  }

  // Blog listing
  const latestPost = posts[0];
  urls.push(`  <url>
    <loc>${SITE_URL}/blog/</loc>${latestPost ? `\n    <lastmod>${latestPost.lastmod || latestPost.date}</lastmod>` : ""}
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`);

  // Blog posts
  for (const post of posts) {
    urls.push(`  <url>
    <loc>${SITE_URL}/blog/${post.slug}/</loc>
    <lastmod>${post.lastmod || post.date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
  fs.writeFileSync(SITEMAP_PATH, xml);
  console.log(`  sitemap.xml (${STATIC_PAGES.length} static + ${posts.length + 1} blog)`);
}

// ── Main ─────────────────────────────────────────────────────────
function build() {
  console.log("Building blog...");
  const posts = readPosts();

  if (posts.length === 0) {
    console.log("  No posts found in blog/posts/. Generating empty listing.");
  }

  // Generate article pages
  for (const post of posts) {
    const dir = path.join(OUTPUT_DIR, post.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), renderArticle(post));
    console.log(`  blog/${post.slug}/index.html`);
  }

  // Generate listing page
  fs.writeFileSync(path.join(OUTPUT_DIR, "index.html"), renderListing(posts));
  console.log("  blog/index.html");

  // Generate sitemap
  buildSitemap(posts);

  console.log(`Done. ${posts.length} article(s) built.`);
}

build();
