import Parser from "rss-parser";
import axios from "axios";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import GoogleNewsDecoderPkg from "google-news-url-decoder";

import { config, validateWordPressConfig } from "./config.js";
import { summarize, generateClickTitle, generateXPost, generateArticleDraft, generateSeoTitle } from "./services/ai.js";
import { postToWordPress, createWordPressContent, postMinimalToWordPress } from "./services/wordpress.js";
import { withRetry } from "./utils/retry.js";

const parser = new Parser();
const { GoogleDecoder } = GoogleNewsDecoderPkg;
const googleDecoder = new GoogleDecoder();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const postedStorePath = path.resolve(__dirname, config.postedStoreFile);
const postedArticlesPath = path.resolve(__dirname, config.postedArticlesFile);
const cachePath = path.resolve(__dirname, config.cacheFile);
const logDirPath = path.resolve(__dirname, config.logDir);
const runLockPath = path.resolve(__dirname, ".run.lock");

function clipText(text, maxLength) {
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeArticleUrl(rawUrl) {
  if (!rawUrl) return "";

  try {
    const parsed = new URL(String(rawUrl));
    const blockedParams = new Set([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "ref",
      "ref_src"
    ]);

    for (const key of [...parsed.searchParams.keys()]) {
      if (blockedParams.has(key) || key.startsWith("utm_")) {
        parsed.searchParams.delete(key);
      }
    }

    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString();
  } catch {
    return String(rawUrl).trim();
  }
}

async function acquireRunLock() {
  try {
    const lockHandle = await fs.open(runLockPath, "wx");
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return lockHandle;
  } catch {
    return null;
  }
}

async function releaseRunLock(lockHandle) {
  if (!lockHandle) return;
  try {
    await lockHandle.close();
  } catch {}
  try {
    await fs.unlink(runLockPath);
  } catch {}
}

function pad(num) {
  return String(num).padStart(2, "0");
}

function formatLogPath(date) {
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  // logs/<月>/<日>/<時>/ ディレクトリに run-<時><分><秒>.log として個別保存
  const dir = path.join(logDirPath, m, d, h);
  const file = `run-${h}${min}${s}.log`;
  return { dir, file };
}

function formatArgs(args) {
  return args
    .map(arg => {
      if (typeof arg === "string") return arg;
      return inspect(arg, { depth: 5, colors: false, breakLength: 120 });
    })
    .join(" ");
}

async function setupRunLogger() {
  const now = new Date();
  const { dir, file } = formatLogPath(now);
  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, file);
  const stream = createWriteStream(filePath, { flags: "a", encoding: "utf-8" });

  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };

  function write(level, originalFn, args) {
    originalFn(...args);
    const timestamp = new Date().toISOString();
    stream.write(`${timestamp} [${level}] ${formatArgs(args)}\n`);
  }

  console.log = (...args) => write("INFO", originalConsole.log, args);
  console.warn = (...args) => write("WARN", originalConsole.warn, args);
  console.error = (...args) => write("ERROR", originalConsole.error, args);

  console.log(`[log] file: ${filePath}`);

  return async () => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    await new Promise(resolve => stream.end(resolve));
  };
}

function getErrorMessage(error) {
  const status = error?.response?.status;
  const data = error?.response?.data;
  const body = data ? ` body=${JSON.stringify(data).slice(0, 600)}` : "";
  const code = error?.code ? ` code=${error.code}` : "";
  const statusText = status ? ` status=${status}` : "";
  return `${error?.message ?? String(error)}${code}${statusText}${body}`;
}

function getWordPressTroubleshootHint(error) {
  const status = error?.response?.status;
  if (status === 401) {
    return "[wp-hint] 401 Unauthorized: WP_USERNAME と WP_APP_PASSWORD(Application Password) を再確認してください。ユーザー権限に投稿権限が必要です。";
  }
  if (status === 404) {
    return "[wp-hint] 404 Not Found: WP_BASE_URL がサイトのルートURLか確認してください。例: https://example.com （末尾に /wp-json は不要）";
  }
  return "";
}

async function notifyError(message) {
  if (!config.discordWebhookUrl) return;

  try {
    await axios.post(
      config.discordWebhookUrl,
      { content: `[ai-news-tool] ${String(message).slice(0, 1800)}` },
      { timeout: 10000 }
    );
  } catch (error) {
    console.error("[notify] failed:", getErrorMessage(error));
  }
}

function getCacheKey(url, type) {
  return `${url}|${type}`;
}

function getCachedValue(cacheMap, key) {
  const record = cacheMap.get(key);
  if (!record) return null;
  if (record && typeof record === "object" && "value" in record) return record.value;
  return record;
}

function setCachedValue(cacheMap, key, value) {
  cacheMap.set(key, { value, updatedAt: new Date().toISOString() });
}

async function loadPostedUrls() {
  try {
    const raw = await fs.readFile(postedStorePath, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return new Set(data.map(normalizeArticleUrl).filter(Boolean));
    if (Array.isArray(data.postedUrls)) return new Set(data.postedUrls.map(normalizeArticleUrl).filter(Boolean));
    return new Set();
  } catch {
    return new Set();
  }
}

async function savePostedUrls(postedSet) {
  const postedUrls = Array.from(postedSet)
    .map(normalizeArticleUrl)
    .filter(Boolean)
    .slice(-3000);
  await fs.writeFile(postedStorePath, JSON.stringify({ postedUrls }, null, 2), "utf-8");
}

async function loadPostedArticles() {
  try {
    const raw = await fs.readFile(postedArticlesPath, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data?.articles) ? data.articles : [];
  } catch {
    return [];
  }
}

async function savePostedArticles(articles) {
  const normalized = articles
    .filter(item => item && item.url && item.title)
    .slice(-1000);
  await fs.writeFile(postedArticlesPath, JSON.stringify({ articles: normalized }, null, 2), "utf-8");
}

async function loadCache() {
  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const data = JSON.parse(raw);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const normalized = entries.map(([key, value]) => {
      if (value && typeof value === "object" && "value" in value) return [key, value];
      return [key, { value, updatedAt: new Date().toISOString() }];
    });
    return new Map(normalized);
  } catch {
    return new Map();
  }
}

async function saveCache(cacheMap) {
  const entries = Array.from(cacheMap.entries()).slice(-config.cacheLimit);
  // TODO: cache TTL を導入し updatedAt を基準に古いデータを失効させる
  await fs.writeFile(cachePath, JSON.stringify({ entries }, null, 2), "utf-8");
}

async function mapWithConcurrency(items, limit, mapper) {
  // TODO: 必要に応じて p-limit へ差し替え、機能ごとの同時実行数を制御する
  const concurrency = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex;
      currentIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function decodeGoogleNewsUrl(link) {
  try {
    const parsed = new URL(link);
    const directUrl = parsed.searchParams.get("url");
    if (directUrl) return directUrl;

    if (parsed.hostname.includes("news.google.com")) {
      const decoded = await googleDecoder.decode(link);
      if (decoded?.status && decoded?.decoded_url) {
        return decoded.decoded_url;
      }
    }

    return link;
  } catch {
    return link;
  }
}

async function resolveFinalUrl(link) {
  const target = await decodeGoogleNewsUrl(link);

  const response = await withRetry(
    () =>
      axios.get(target, {
        timeout: 12000,
        maxRedirects: 8,
        responseType: "text",
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
        },
        validateStatus: status => status >= 200 && status < 400
      }),
    { label: "resolveFinalUrl" }
  );

  const finalUrl = normalizeArticleUrl(response?.request?.res?.responseUrl ?? target);
  return { finalUrl, html: response.data };
}

function extractArticleText(html, url) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  return String(article?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 5000);
}

async function fetchArticleDetails(link) {
  const { finalUrl, html } = await resolveFinalUrl(link);
  const dom = new JSDOM(html, { url: finalUrl });

  const ogImage =
    dom.window.document.querySelector("meta[property='og:image']")?.getAttribute("content") ||
    dom.window.document.querySelector("meta[name='twitter:image']")?.getAttribute("content") ||
    null;

  const articleText = extractArticleText(html, finalUrl);
  return { finalUrl, ogImage, articleText };
}

function scoreNews(news) {
  let score = 0;
  const title = news.title ?? "";
  const snippet = news.contentSnippet ?? "";
  const text = `${title}\n${snippet}\n${news.articleText ?? ""}`;

  const highIntentKeywords = ["速報", "決算", "買収", "提携", "新商品", "新型", "発表"];
  const buzzKeywords = ["AI", "OpenAI", "生成AI", "iPhone", "Apple", "トレンド"];
  const shockKeywords = ["炎上", "不祥事", "終了", "廃止", "値上げ", "無料", "リーク", "暴露"];
  const impactKeywords = ["政府", "規制", "法案", "障害", "漏えい", "セキュリティ", "倒産"];
  const warKeywords = ["戦争", "軍事", "侵攻", "停戦", "ミサイル", "中東", "ロシア", "ウクライナ"];
  const entertainmentTechKeywords = ["AI", "生成AI", "アプリ", "スマホ", "iPhone", "Apple", "ゲーム", "SNS", "話題", "トレンド"];
  const emotionKeywords = ["衝撃", "ヤバい", "すごい", "驚愕", "激震"];

  for (const keyword of highIntentKeywords) if (text.includes(keyword)) score += 5;
  for (const keyword of buzzKeywords) if (text.includes(keyword)) score += 6;
  for (const keyword of shockKeywords) if (text.includes(keyword)) score += 5;
  for (const keyword of impactKeywords) if (text.includes(keyword)) score += 2;
  for (const keyword of entertainmentTechKeywords) if (text.includes(keyword)) score += 4;
  for (const keyword of warKeywords) if (text.includes(keyword)) score -= 5;

  if (title.includes("炎上")) score += 6;
  if (title.includes("終了")) score += 5;
  if (title.includes("廃止")) score += 5;
  if (title.includes("無料")) score += 4;
  if (title.includes("値上げ")) score += 4;
  if (/\d/.test(title)) score += 2;
  if (title.includes("?") || title.includes("？")) score += 2;
  if (emotionKeywords.some(keyword => title.includes(keyword))) score += 3;

  if ((news.articleText ?? "").length > 800) score += 3;
  if ((news.articleText ?? "").length > 1500) score += 2;

  const publishedAt = news.isoDate ? new Date(news.isoDate).getTime() : null;
  if (publishedAt) {
    const ageHours = (Date.now() - publishedAt) / (1000 * 60 * 60);
    if (ageHours <= 6) score += 4;
    else if (ageHours <= 24) score += 2;
  }

  if (news.ogImage) score += 1;
  return score;
}

function classifyGenre(news) {
  const text = `${news.title ?? ""}\n${news.contentSnippet ?? ""}\n${news.articleText ?? ""}`;

  const definitions = {
    politics: ["政府", "法案", "中国", "台湾", "米国", "外交", "首相", "大統領"],
    it: ["AI", "Apple", "iPhone", "Google", "OpenAI", "生成AI", "アプリ", "スマホ", "ガジェット"],
    entertainment: ["映画", "アニメ", "芸能", "ゲーム"],
    business: ["決算", "買収", "提携", "株価", "市場", "投資", "新会社", "発売"],
    trend: ["話題", "トレンド", "炎上", "SNS", "無料", "値上げ"]
  };

  let bestGenre = "general";
  let bestScore = 0;

  for (const [genre, keywords] of Object.entries(definitions)) {
    let genreScore = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) genreScore += 1;
    }
    if (genreScore > bestScore) {
      bestScore = genreScore;
      bestGenre = genre;
    }
  }

  return bestGenre;
}

function selectBalancedNews(newsList, maxPosts) {
  const genreCounts = new Map();
  const selected = [];

  for (const news of newsList) {
    const genre = classifyGenre(news);
    const currentCount = genreCounts.get(genre) ?? 0;

    if (currentCount >= 2) continue;

    selected.push({ ...news, genre });
    genreCounts.set(genre, currentCount + 1);

    if (selected.length >= maxPosts) break;
  }

  return selected;
}

function extractSourceName(title) {
  const source = String(title ?? "").split(" - ").pop()?.trim();
  return source || "元ニュース";
}

function tokenize(text) {
  return String(text ?? "")
    .replace(/[【】「」『』（）()]/g, " ")
    .split(/[\s、。,:：・!！?？\-—]+/)
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length >= 2)
    .filter(token => !["ニュース", "速報", "最新"].includes(token));
}

function findRelatedArticles(news, postedArticles, categoryKey, max = 3) {
  const currentTokens = new Set(tokenize(news.title));

  const scored = postedArticles
    .filter(item => item?.categoryKey === categoryKey)
    .filter(item => item?.sourceUrl !== news.finalUrl)
    .map(item => {
      const tokens = tokenize(item.title);
      let score = 0;
      for (const token of tokens) {
        if (currentTokens.has(token)) score += 1;
      }
      return { ...item, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime();
    })
    .slice(0, max)
    .map(item => ({ title: item.title, url: item.url }));

  return scored;
}

function findRecentArticles(news, postedArticles, max = 5) {
  return postedArticles
    .filter(item => item?.url && item?.title)
    .filter(item => normalizeArticleUrl(item.sourceUrl ?? "") !== normalizeArticleUrl(news.finalUrl))
    .sort((a, b) => new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime())
    .slice(0, max)
    .map(item => ({ title: item.title, url: item.url }));
}

function summarizeCategoryCounts(newsList) {
  const counts = new Map();
  for (const news of newsList) {
    const genre = news.genre ?? classifyGenre(news);
    counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  return Object.fromEntries(counts.entries());
}

function resolveWpCategoryKey(news) {
  const genre = classifyGenre(news);
  if (genre === "politics") return "politics";
  if (genre === "business") return "economy";
  if (genre === "entertainment") return "entertainment";
  if (genre === "war") return "world";
  if (genre === "it" || genre === "tech" || genre === "trend") return "it";
  return "world";
}

function mergeUniqueByLink(newsItems) {
  const seen = new Set();
  const deduped = [];

  for (const item of newsItems) {
    const key = item.link || item.guid || `${item.title}|${item.pubDate}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

async function getNews() {
  const feedResults = await mapWithConcurrency(config.rssUrls, config.concurrency, async rssUrl => {
    try {
      const feed = await withRetry(() => parser.parseURL(rssUrl), { label: `getNews:${rssUrl}` });
      const items = (feed.items ?? []).slice(0, config.fetchPerFeedLimit).map(item => ({
        ...item,
        rssSource: rssUrl,
        rssTitle: feed.title ?? rssUrl
      }));

      console.log(`[rss] ${feed.title ?? rssUrl}: ${items.length}件取得`);
      return items;
    } catch (error) {
      const msg = `[rss] failed: ${rssUrl} -> ${getErrorMessage(error)}`;
      console.error(msg);
      await notifyError(msg);
      return [];
    }
  });

  const merged = feedResults.flat();
  const deduped = mergeUniqueByLink(merged);
  const limited = deduped.slice(0, config.totalFetchLimit);

  console.log(`[rss] merged=${merged.length} deduped=${deduped.length} totalLimited=${limited.length}`);
  return limited;
}

async function buildNewsAssets(news, cache, categoryKey = "world") {
  const sourceText = clipText(`${news.title}\n${news.contentSnippet ?? ""}\n${news.articleText ?? ""}`, 3000);

  const summaryKey = getCacheKey(news.finalUrl, "summary");
  const xPostKey = getCacheKey(news.finalUrl, `xpost:${categoryKey}`);
  const clickTitleKey = getCacheKey(news.finalUrl, `clicktitle:${categoryKey}`);
  const seoTitleKey = getCacheKey(news.finalUrl, `seotitle:${categoryKey}`);
  const articleKey = getCacheKey(news.finalUrl, "article:v3");

  let summary = getCachedValue(cache, summaryKey);
  if (!summary) {
    summary = await summarize({ apiKey: config.openaiApiKey, model: config.openaiModel, sourceText });
    setCachedValue(cache, summaryKey, summary);
  }

  let xPostDraft = getCachedValue(cache, xPostKey);
  if (!xPostDraft) {
    xPostDraft = await generateXPost({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      news,
      category: categoryKey
    });
    setCachedValue(cache, xPostKey, xPostDraft);
  }

  let clickTitle = getCachedValue(cache, clickTitleKey);
  if (!clickTitle) {
    clickTitle = await generateClickTitle({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      title: news.title,
      contentSnippet: news.contentSnippet,
      category: categoryKey
    });
    setCachedValue(cache, clickTitleKey, clickTitle);
  }

  let seoTitle = getCachedValue(cache, seoTitleKey);
  if (!seoTitle) {
    seoTitle = await generateSeoTitle({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      title: news.title,
      contentSnippet: news.contentSnippet,
      category: categoryKey
    });
    setCachedValue(cache, seoTitleKey, seoTitle);
  }

  let articleDraft = getCachedValue(cache, articleKey);
  if (!articleDraft) {
    articleDraft = await generateArticleDraft({ apiKey: config.openaiApiKey, model: config.openaiModel, news });
    setCachedValue(cache, articleKey, articleDraft);
  }

  return { summary, xPostDraft, clickTitle, seoTitle, articleDraft };
}

function printPreview({ news, clickTitle, seoTitle, summary, xPostDraft, articleDraft, wpResult, sourceName, recentArticles, categoryKey, categoryId }) {
  const wpDraftHtml = createWordPressContent(news, articleDraft, {
    sourceName,
    recentArticles,
    summaryText: summary,
    ctaText: articleDraft.cta
  });

  console.log("\n---");
  console.log("タイトル:", news.title);
  console.log("リライトタイトル:", clickTitle);
  console.log("URL:", news.finalUrl);
  console.log("スコア:", news.score);
  if (categoryKey) {
    console.log("カテゴリ:", `${categoryKey} (ID: ${categoryId ?? "n/a"})`);
  }

  console.log("\n▼X投稿案");
  console.log(xPostDraft);

  console.log("\n▼要約");
  console.log(summary);

  console.log("\n▼WordPressタイトル");
  console.log(clickTitle);

  console.log("\n▼SEOタイトル");
  console.log(seoTitle);

  console.log("\n▼WordPress本文（HTML）");
  console.log(wpDraftHtml);

  if (wpResult?.link) {
    console.log("\n▼WordPress投稿URL");
    console.log(wpResult.link);
  }

  console.log("\nWP:", wpResult);
}

async function executeOnce() {
  if (globalThis.isRunning) {
    console.log("skip: already running");
    return;
  }

  globalThis.isRunning = true;
  const runLock = await acquireRunLock();
  if (!runLock) {
    globalThis.isRunning = false;
    console.log("skip: already running");
    return;
  }

  let restoreLogger = async () => {};

  try {
  restoreLogger = await setupRunLogger();
  console.log("=== run start ===", new Date().toISOString());
  console.log(`mode: ${config.testMode ? "TEST_MODE(preview)" : "PRODUCTION(post)"}`);

  if (config.legacyOutputOnly && process.env.TEST_MODE === undefined) {
    console.warn("[deprecated] OUTPUT_ONLY_MODE is deprecated. Use TEST_MODE instead.");
  }

  const wpMissing = validateWordPressConfig();
  const wpConfigured = wpMissing.length === 0;
  if (!wpConfigured) {
    console.warn(`[wp] missing env: ${wpMissing.join(", ")}`);
  }

  if (!config.testMode && wpConfigured && config.wordpress.minimalTestPost) {
    try {
      const minimal = await postMinimalToWordPress({ wpConfig: config.wordpress });
      console.log("[wp] minimal test post succeeded:", minimal);
    } catch (error) {
      const msg = `[wp] minimal test post failed: ${getErrorMessage(error)}`;
      console.error(msg);
      const hint = getWordPressTroubleshootHint(error);
      if (hint) console.error(hint);
      await notifyError(`${msg}${hint ? `\n${hint}` : ""}`);
    }
  }

  const postedUrls = await loadPostedUrls();
  const postedArticles = await loadPostedArticles();
  const cache = await loadCache();
  const newsList = await getNews();

  const scanTargets = newsList;

  const seenInRun = new Set();
  const fetched = await mapWithConcurrency(scanTargets, config.concurrency, async news => {
    const cacheKey = getCacheKey(news.link, "articleDetails");
    let details = getCachedValue(cache, cacheKey);

    if (!details) {
      try {
        details = await fetchArticleDetails(news.link);
        setCachedValue(cache, cacheKey, details);
      } catch (error) {
        const fallbackUrl = normalizeArticleUrl(await decodeGoogleNewsUrl(news.link));
        console.warn(`[article] fallback to snippet: ${news.link} -> ${getErrorMessage(error)}`);
        details = {
          finalUrl: fallbackUrl || normalizeArticleUrl(news.link),
          ogImage: null,
          articleText: clipText(news.contentSnippet ?? news.title ?? "", 400)
        };
      }
    }

    const canonicalUrl = normalizeArticleUrl(details.finalUrl || news.link);
    if (postedUrls.has(canonicalUrl)) return null;
    if (seenInRun.has(canonicalUrl)) return null;
    seenInRun.add(canonicalUrl);

    return {
      ...news,
      finalUrl: canonicalUrl,
      ogImage: details.ogImage,
      articleText: details.articleText,
      score: 0
    };
  });

  const enrichedNews = fetched.filter(Boolean);

  const allScoredNews = enrichedNews
    .map(item => ({ ...item, score: scoreNews(item) }))
    .sort((a, b) => b.score - a.score)
;

  const preferredNews = allScoredNews.filter(item => item.score >= config.minScore);
  let selected = selectBalancedNews(preferredNews, config.maxPosts);

  if (selected.length < config.minPosts) {
    const selectedUrls = new Set(selected.map(item => item.finalUrl));
    const backupCandidates = allScoredNews.filter(item => !selectedUrls.has(item.finalUrl));
    const supplemented = selectBalancedNews(backupCandidates, config.minPosts - selected.length);
    selected = [...selected, ...supplemented].slice(0, config.maxPosts);
  }

  console.log(`[select] preferred=${preferredNews.length} selected=${selected.length}`);
  console.log("[select] categories:", summarizeCategoryCounts(selected));

  const results = await mapWithConcurrency(selected, config.concurrency, async news => {
    try {
      const categoryKey = resolveWpCategoryKey(news);
      const { summary, xPostDraft, clickTitle, seoTitle, articleDraft } = await buildNewsAssets(news, cache, categoryKey);
      const sourceName = extractSourceName(news.title);
      const recentArticles = findRecentArticles(news, postedArticles, 5);
      const categoryId =
        config.wordpress.categoryIdMap[categoryKey] ??
        config.wordpress.categoryIdMap.world;

      if (config.testMode || !wpConfigured) {
        return {
          news,
          clickTitle,
          seoTitle,
          summary,
          xPostDraft,
          articleDraft,
          sourceName,
          recentArticles,
          categoryKey,
          categoryId,
          wpResult: {
            skipped: true,
            reason: config.testMode ? "TEST_MODE" : "WP_CONFIG_MISSING"
          }
        };
      }

      const wpResult = await postToWordPress({
        wpConfig: config.wordpress,
        news,
        clickTitle,
        seoTitle,
        summary,
        draft: articleDraft,
        sourceName,
        recentArticles,
        categoryId
      });

      if (wpResult?.id) {
        postedUrls.add(normalizeArticleUrl(news.finalUrl));
        postedArticles.push({
          title: clickTitle,
          url: wpResult.link || news.finalUrl,
          sourceUrl: normalizeArticleUrl(news.finalUrl),
          categoryKey,
          postedAt: new Date().toISOString()
        });
      }

      return {
        news,
        clickTitle,
        seoTitle,
        summary,
        xPostDraft,
        articleDraft,
        wpResult,
        sourceName,
        recentArticles,
        categoryKey,
        categoryId
      };
    } catch (error) {
      const msg = `[item] failed: ${news.title} -> ${getErrorMessage(error)}`;
      console.error(msg);
      const hint = getWordPressTroubleshootHint(error);
      if (hint) console.error(hint);
      await notifyError(`${msg}${hint ? `\n${hint}` : ""}`);
      return null;
    }
  });

  for (const result of results) {
    if (!result) continue;
    printPreview(result);
  }

  // TODO: Googleトレンド連携
  // TODO: SNSバズ分析
  // TODO: 投稿パフォーマンス記録

  await savePostedUrls(postedUrls);
  await savePostedArticles(postedArticles);
  await saveCache(cache);

  console.log("=== run end ===", new Date().toISOString());
  } finally {
    await releaseRunLock(runLock);
    globalThis.isRunning = false;
    await restoreLogger();
  }
}

async function main() {
  if (config.scheduleMinutes > 0) {
    await executeOnce();
    setInterval(async () => {
      if (globalThis.isRunning) {
        console.warn("skip: previous run is still running");
        return;
      }
      try {
        await executeOnce();
      } catch (error) {
        console.error("scheduled run failed:", getErrorMessage(error));
      }
    }, config.scheduleMinutes * 60 * 1000);
    return;
  }

  await executeOnce();
}

main().catch(async error => {
  const msg = `fatal: ${getErrorMessage(error)}`;
  console.error(msg);
  await notifyError(msg);
  process.exit(1);
});
