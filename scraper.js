const https = require('https');
const fs = require('fs');

const ANTHROPIC_KEY = 'process.env.ANTHROPIC_KEY';
const PH_TOKEN = 'process.env.PH_TOKEN';
const DATA_FILE = '/data/painpoints.json';

const SUBREDDITS = [
  'entrepreneur', 'SaaS', 'smallbusiness', 'startups', 'freelance',
  'agency', 'consulting', 'growmybusiness', 'marketing', 'SEO',
  'socialmedia', 'digital_marketing', 'sales', 'nocode', 'automation',
  'ecommerce', 'dropshipping', 'passive_income', 'AmazonFBA', 'shopify',
  'YoutubeCreators', 'podcasting', 'blogging', 'personalfinance',
  'fitness', 'remotework', 'digitalnomad', 'Parenting', 'productivity', 'notion'
];

function get(options) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(''));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse RSS XML — simple regex based, no dependencies needed
function parseRSS(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of itemMatches) {
    const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
    const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/) || [])[1] || '';
    // Strip HTML tags from description
    const text = desc.replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim().substring(0, 300);
    if (title && title.length > 5) items.push({ title, text });
  }
  return items;
}

// Reddit RSS scraper
async function fetchReddit(subreddit) {
  try {
    const data = await get({
      hostname: 'www.reddit.com',
      path: `/r/${subreddit}/hot.rss?limit=15`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PainPointRadar/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      }
    });
    const items = parseRSS(data);
    return items.map(p => ({
      title: p.title,
      text: p.text,
      score: 100,
      num_comments: 0,
      platform: 'Reddit',
      source: `r/${subreddit}`
    }));
  } catch(e) {
    console.log(`Reddit r/${subreddit} failed:`, e.message);
    return [];
  }
}

// Product Hunt with OAuth token
async function fetchPH() {
  try {
    const q = JSON.stringify({
      query: `{ posts(order: VOTES, first: 30) { edges { node { name tagline description votesCount commentsCount } } } }`
    });
    const data = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.producthunt.com',
        path: '/v2/api/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${PH_TOKEN}`,
          'Content-Length': Buffer.byteLength(q)
        }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d));
      });
      req.on('error', () => resolve(''));
      req.write(q);
      req.end();
    });
    const p = JSON.parse(data);
    return p.data.posts.edges.map(e => e.node).map(p => ({
      title: p.name + ' — ' + p.tagline,
      text: p.description ? p.description.substring(0, 300) : '',
      score: p.votesCount,
      num_comments: p.commentsCount,
      platform: 'ProductHunt',
      source: 'Product Hunt'
    }));
  } catch(e) {
    console.log('PH failed:', e.message);
    return [];
  }
}

// App Store 1-3 star reviews
async function fetchAppStore() {
  try {
    const data = await get({
      hostname: 'itunes.apple.com',
      path: '/us/rss/topfreeapplications/limit=20/json',
      method: 'GET',
      headers: { 'User-Agent': 'PainPointRadar/1.0' }
    });
    const apps = JSON.parse(data).feed.entry || [];
    const results = [];
    for (const app of apps.slice(0, 8)) {
      const id = app.id?.attributes?.['im:id'];
      const name = app['im:name']?.label;
      if (!id) continue;
      await sleep(500);
      const rd = await get({
        hostname: 'itunes.apple.com',
        path: `/us/rss/customerreviews/id=${id}/sortBy=mostRecent/json`,
        method: 'GET',
        headers: { 'User-Agent': 'PainPointRadar/1.0' }
      });
      try {
        const entries = JSON.parse(rd).feed?.entry || [];
        entries.slice(0, 5).forEach(r => {
          const rating = parseInt(r['im:rating']?.label || '5');
          const content = r.content?.label || '';
          if (rating <= 3 && content.length > 30) {
            results.push({
              title: `${name}: ${r.title?.label}`,
              text: content.substring(0, 300),
              score: (4 - rating) * 25,
              num_comments: 0,
              platform: 'AppStore',
              source: `App Store — ${name}`
            });
          }
        });
      } catch(e) {}
    }
    return results;
  } catch(e) {
    console.log('AppStore failed:', e.message);
    return [];
  }
}

// Claude analysis
async function analyse(posts) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: `You are a market research AI. Analyse these REAL posts scraped from the internet today.

Find pain points that:
- Non-technical people or small business owners could build solutions for
- Have clear commercial potential
- Are NOT developer/programming specific problems
- Could be solved with an app, SaaS tool, or automation bot

REAL POSTS:
${JSON.stringify(posts.slice(0, 80).map(p => ({ title: p.title, text: p.text, platform: p.platform, source: p.source })))}

Return ONLY a JSON array of the top 10 pain points:
[
  {
    "id": "unique_snake_case_id",
    "platform": "Reddit or ProductHunt or AppStore",
    "subreddit": "r/source if reddit",
    "title": "PUNCHY HEADLINE",
    "summary": "2-3 sentences about the frustration and why existing solutions fail",
    "engagement": 500,
    "comments": 50,
    "heatScore": 78,
    "opportunities": ["App", "SaaS"],
    "category": "Category",
    "quotes": [
      {"text": "quote from real posts", "source": "platform · source"}
    ],
    "marketSize": "who would pay and rough size",
    "buildIdea": "specific thing to build"
  }
]

Only return JSON, no other text.`
    }]
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const text = JSON.parse(d).content.map(i => i.text || '').join('');
          const clean = text.replace(/```json|```/g, '').trim();
          const last = clean.lastIndexOf('}');
          const fixed = !clean.trimEnd().endsWith(']') ? clean.substring(0, last + 1) + ']' : clean;
          resolve(JSON.parse(fixed));
        } catch(e) {
          console.error('Parse error:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Starting PainPoint Radar scrape...');
  let allPosts = [];
  const seen = new Set();

  // Reddit RSS
  for (const sub of SUBREDDITS) {
    console.log(`Scraping r/${sub}...`);
    const posts = await fetchReddit(sub);
    posts.forEach(p => {
      if (!seen.has(p.title)) {
        seen.add(p.title);
        allPosts.push(p);
      }
    });
    await sleep(800);
  }

  // Product Hunt
  console.log('Scraping Product Hunt...');
  const ph = await fetchPH();
  allPosts = allPosts.concat(ph);
  console.log(`Got ${ph.length} Product Hunt posts`);

  // App Store
  console.log('Scraping App Store...');
  const apps = await fetchAppStore();
  allPosts = allPosts.concat(apps);
  console.log(`Got ${apps.length} App Store reviews`);

  console.log(`Total: ${allPosts.length} posts. Analysing with Claude...`);

  const results = await analyse(allPosts);

  if (!results.length) {
    console.log('No results found.');
    return;
  }

  // Load existing data
  let existing = [];
  try {
    if (fs.existsSync(DATA_FILE)) {
      existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) { existing = []; }

  // Add metadata
  const now = new Date();
  const t = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    + ' ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  results.forEach(p => {
    p.uid = p.id + '_' + Date.now();
    p.scannedAt = t;
    p.isReal = true;
  });

  const updated = [...results, ...existing].slice(0, 500);
  fs.mkdirSync('/data', { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(updated, null, 2));

  console.log(`Done! Saved ${results.length} new pain points. Total: ${updated.length}`);
}

main().catch(console.error);
