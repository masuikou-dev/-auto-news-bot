import dotenv from "dotenv";

dotenv.config({ path: [".env", ".env.example"], override: false });

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIdList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map(id => Number(id.trim()))
    .filter(id => Number.isInteger(id) && id > 0);
}

function toInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseStringList(value) {
  if (!value) return [];
  return String(value)
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parseMonetizationLinks(value) {
  if (!value) return [];

  const lines = String(value)
    .split(/\n/)
    .map(line => line.trim())
    .filter(Boolean);

  return lines
    .map(line => {
      const [title, url] = line.split("|").map(item => item?.trim());
      if (!title || !url) return null;
      return { title, url };
    })
    .filter(Boolean)
    .slice(0, 3);
}

const legacyOutputOnly = toBool(process.env.OUTPUT_ONLY_MODE, false);
const testMode = process.env.TEST_MODE !== undefined ? toBool(process.env.TEST_MODE, false) : legacyOutputOnly;
const apiKey = process.env.OPENAI_API_KEY;
const wpUser = process.env.WP_USERNAME;
const wpPass = process.env.WP_APP_PASSWORD;

export const config = {
  rssUrl: process.env.RSS_URL ?? "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja",
  rssUrls:
    parseStringList(process.env.RSS_URLS).length > 0
      ? parseStringList(process.env.RSS_URLS)
      : [process.env.RSS_URL ?? "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja"],
  openaiApiKey: apiKey,
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",

  maxPosts: toNumber(process.env.MAX_POSTS, 5),
  minPosts: toNumber(process.env.MIN_POSTS, 2),
  fetchLimit: toNumber(process.env.FETCH_LIMIT, 20),
  fetchPerFeedLimit: toNumber(process.env.FETCH_PER_FEED_LIMIT, toNumber(process.env.FETCH_LIMIT, 20)),
  totalFetchLimit: toNumber(process.env.TOTAL_FETCH_LIMIT, 50),
  minScore: toNumber(process.env.MIN_SCORE, 4),
  scheduleMinutes: toNumber(process.env.SCHEDULE_MINUTES, 0),
  concurrency: toNumber(process.env.CONCURRENCY, 3),
  cacheLimit: toNumber(process.env.CACHE_LIMIT, 500),

  testMode,
  legacyOutputOnly,

  postedStoreFile: process.env.POSTED_STORE_FILE ?? "posted_urls.json",
  postedArticlesFile: process.env.POSTED_ARTICLES_FILE ?? "posted_articles.json",
  cacheFile: process.env.CACHE_FILE ?? "content_cache.json",
  logDir: process.env.LOG_DIR ?? "logs",
  logFileUnit: process.env.LOG_FILE_UNIT ?? "hour",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? "",

  wordpress: {
    baseUrl: process.env.WP_BASE_URL ?? "",
    username: wpUser ?? "",
    appPassword: wpPass ?? "",
    status: process.env.WP_STATUS ?? "publish",
    minimalTestPost: toBool(process.env.WP_MINIMAL_TEST_POST, false),
    categoryIds: parseIdList(process.env.WP_CATEGORY_IDS),
    categoryIdMap: {
      it: toInt(process.env.WP_CATEGORY_IT, 16),
      economy: toInt(process.env.WP_CATEGORY_ECONOMY, 19),
      politics: toInt(process.env.WP_CATEGORY_POLITICS, 20),
      entertainment: toInt(process.env.WP_CATEGORY_ENTERTAINMENT, 21),
      entertaimant: toInt(process.env.WP_CATEGORY_ENTERTAIMANT, 21),
      world: toInt(process.env.WP_CATEGORY_WORLD, 22)
    },
    tagIds: parseIdList(process.env.WP_TAG_IDS),
    metaDescriptionKey: process.env.WP_META_DESCRIPTION_KEY ?? "",
    seoTitleKey: process.env.WP_SEO_TITLE_KEY ?? "",
    monetizationLinks: parseMonetizationLinks(process.env.WP_MONETIZATION_LINKS)
  },

  futureX: {
    enabled: toBool(process.env.X_ENABLED, false),
    apiKey: process.env.X_API_KEY ?? "",
    apiSecret: process.env.X_API_SECRET ?? "",
    accessToken: process.env.X_ACCESS_TOKEN ?? "",
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET ?? ""
  }
};

export function validateWordPressConfig() {
  const missing = [];
  if (!config.wordpress.baseUrl) missing.push("WP_BASE_URL");
  if (!config.wordpress.username) missing.push("WP_USERNAME");
  if (!config.wordpress.appPassword) missing.push("WP_APP_PASSWORD");
  return missing;
}
