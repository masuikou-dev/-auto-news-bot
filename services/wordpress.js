import axios from "axios";
import { withRetry } from "../utils/retry.js";

function clipText(text, maxLength) {
  const source = String(text ?? "").trim();
  if (source.length <= maxLength) return source;
  return `${source.slice(0, maxLength)}…`;
}

function buildBasicAuth(username, appPassword) {
  return Buffer.from(`${username}:${appPassword}`).toString("base64");
}

function getFilenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split("/").pop() || "featured-image.jpg";
    return name.includes(".") ? name : `${name}.jpg`;
  } catch {
    return "featured-image.jpg";
  }
}

function buildFallbackSlug(title, index = 0) {
  const base = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  const safe = base || `news-${Date.now().toString(36)}`;
  return index > 0 ? `${safe}-${index + 1}` : safe;
}

function formatSummaryToHtml(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);

  return lines
    .map(line => {
      // 「・ラベル」行は太字見出しとして出力
      const labelMatch = line.match(/^・([^→]+)$/);
      if (labelMatch) {
        return `<p><strong>${labelMatch[1].trim()}</strong></p>`;
      }
      // 「→ 本文」行はそのまま段落
      const arrowMatch = line.match(/^→\s*(.+)$/);
      if (arrowMatch) {
        return `<p>${arrowMatch[1].trim()}</p>`;
      }
      return `<p>${line}</p>`;
    })
    .join("\n");
}

function formatSectionParagraphs(text, maxLength = 120) {
  const source = String(text ?? "").trim();
  if (!source) return "";

  const normalized = source.replace(/\n+/g, "\n");
  const lines = normalized
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  const chunks = [];
  for (const line of lines) {
    if (line.length <= maxLength) {
      chunks.push(line);
      continue;
    }

    const parts = line.split(/(?<=[。！？])/).map(part => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      chunks.push(...parts);
    } else {
      chunks.push(line.slice(0, maxLength));
      chunks.push(line.slice(maxLength));
    }
  }

  return chunks.map(chunk => `<p>${chunk}</p>`).join("\n");
}

function formatKeyPointsToHtml(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  const bullets = lines
    .filter(line => /^[-・]/.test(line))
    .map(line => line.replace(/^[-・]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 5);

  const nonBullets = lines
    .filter(line => !/^[-・]/.test(line))
    .map(line => line.trim())
    .filter(Boolean);

  if (bullets.length === 0) {
    return formatSectionParagraphs(text, 120);
  }

  const listHtml = `<ul>\n${bullets.map(item => `  <li>${item}</li>`).join("\n")}\n</ul>`;
  const insight = nonBullets.length > 0 ? `<p>${clipText(nonBullets.join(" "), 140)}</p>` : "";
  return `${listHtml}\n${insight}`.trim();
}

function normalizeInternalLinksForHtml(draftLinks, relatedArticles) {
  const fromRelated = Array.isArray(relatedArticles)
    ? relatedArticles
        .map(item => ({
          title: String(item?.title ?? "").trim(),
          url: String(item?.url ?? "").trim()
        }))
        .filter(item => item.title && item.url)
        .slice(0, 3)
    : [];

  if (fromRelated.length > 0) return fromRelated;

  const fromDraft = Array.isArray(draftLinks)
    ? draftLinks
        .map(item => ({
          title: String(item?.title ?? "").trim(),
          url: String(item?.url ?? "").trim()
        }))
        .filter(item => item.title && item.url)
        .slice(0, 3)
    : [];

  return fromDraft;
}

async function ensureUniqueSlug(baseUrl, authHeader, desiredSlug, fallbackTitle) {
  for (let i = 0; i < 20; i += 1) {
    const candidate = desiredSlug ? buildFallbackSlug(desiredSlug, i) : buildFallbackSlug(fallbackTitle, i);
    const url = `${baseUrl}/wp-json/wp/v2/posts?slug=${encodeURIComponent(candidate)}&_fields=id,slug`;

    const res = await withRetry(
      () => axios.get(url, { timeout: 12000, headers: { Authorization: authHeader } }),
      { label: "ensureUniqueSlug" }
    );

    if (!Array.isArray(res.data) || res.data.length === 0) {
      return candidate;
    }
  }

  return `${buildFallbackSlug(fallbackTitle)}-${Date.now().toString(36)}`;
}

async function ensureUniqueTitle(baseUrl, authHeader, desiredTitle) {
  const checkUrl = `${baseUrl}/wp-json/wp/v2/posts?search=${encodeURIComponent(desiredTitle)}&_fields=id,title.rendered&per_page=20`;
  const res = await withRetry(
    () => axios.get(checkUrl, { timeout: 12000, headers: { Authorization: authHeader } }),
    { label: "ensureUniqueTitle" }
  );

  const normalized = desiredTitle.replace(/\s+/g, "").toLowerCase();
  const duplicated = (res.data ?? []).some(post => {
    const rendered = String(post?.title?.rendered ?? "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
    return rendered === normalized;
  });

  if (!duplicated) return desiredTitle;
  // タイトル重複時は (2)(3)... のカウンターで区別する
  for (let i = 2; i <= 9; i++) {
    const candidate = `${desiredTitle}（${i}）`;
    const cNorm = candidate.replace(/\s+/g, "").toLowerCase();
    const used = (res.data ?? []).some(post => {
      const rendered = String(post?.title?.rendered ?? "")
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, "")
        .toLowerCase();
      return rendered === cNorm;
    });
    if (!used) return candidate;
  }
  return `${desiredTitle}（${Date.now().toString(36)}）`;
}

export function createWordPressContent(news, draft, options = {}) {
  const sourceName = options.sourceName || "元ニュース";
  const summaryText = options.summaryText || "";
  const recentArticles = Array.isArray(options.recentArticles) ? options.recentArticles.slice(0, 5) : [];
  const ctaText = String(options.ctaText || draft.cta || "気になる方は、他の記事もチェックしてみてください。").trim();
  const internalLinks = normalizeInternalLinksForHtml(draft.internalLinks, []);

  const internalLinksHtml = internalLinks.length
    ? `
<ul>
${internalLinks.map(item => `  <li><a href="${item.url}" target="_blank" rel="noopener noreferrer">${item.title}</a></li>`).join("\n")}
</ul>
`
    : "";

  const recentHtml = recentArticles.length
    ? `
<h2>あわせて読みたい</h2>
<ul>
${recentArticles.map(item => `  <li><a href="${item.url}">${item.title}</a></li>`).join("\n")}
</ul>
`
    : "";

  return `
${news.ogImage ? `<p><img src="${news.ogImage}" alt="${news.title}"></p>` : ""}
<h2>要約</h2>
${formatSummaryToHtml(summaryText)}
<h2>結論：これ何が起きてる？</h2>
${formatSectionParagraphs(clipText(draft.conclusion, 190), 120)}
<h2>これってどういうこと？</h2>
${formatSectionParagraphs(clipText(draft.whatItMeans, 230), 120)}
<h2>ここがポイント</h2>
${formatKeyPointsToHtml(clipText(draft.keyPoints, 260))}
<h2>ちょっと気になるのは</h2>
${formatSectionParagraphs(clipText(draft.impact, 230), 120)}
<h2>今後どうなりそう？</h2>
${formatSectionParagraphs(clipText(draft.future, 230), 120)}
<h2>まとめ</h2>
${formatSectionParagraphs(clipText(draft.summary, 170), 120)}
<p>${clipText(ctaText, 170)}</p>
<h2>元記事</h2>
<p>出典：${sourceName}（<a href="${news.finalUrl}" target="_blank" rel="noopener noreferrer">リンク</a>）</p>
${recentHtml}
`.trim();
}

async function uploadFeaturedMedia({ baseUrl, authHeader, imageUrl, title }) {
  if (!imageUrl) return null;

  const imageResponse = await withRetry(
    () =>
      axios.get(imageUrl, {
        responseType: "arraybuffer",
        timeout: 15000
      }),
    { label: "downloadFeaturedImage" }
  );

  const fileName = getFilenameFromUrl(imageUrl);
  const contentType = imageResponse.headers["content-type"] || "image/jpeg";

  const mediaRes = await withRetry(
    () =>
      axios.post(`${baseUrl}/wp-json/wp/v2/media`, imageResponse.data, {
        timeout: 20000,
        headers: {
          Authorization: authHeader,
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${fileName}"`
        }
      }),
    { label: "uploadFeaturedMedia" }
  );

  const mediaId = mediaRes.data?.id;
  if (mediaId) {
    await withRetry(
      () =>
        axios.post(
          `${baseUrl}/wp-json/wp/v2/media/${mediaId}`,
          { alt_text: title },
          {
            timeout: 12000,
            headers: { Authorization: authHeader }
          }
        ),
      { label: "updateFeaturedMediaAlt" }
    );
  }

  return mediaId ?? null;
}

export async function postToWordPress({
  wpConfig,
  news,
  clickTitle,
  seoTitle,
  summary,
  draft,
  sourceName,
  recentArticles,
  categoryId
}) {
  const baseUrl = wpConfig.baseUrl.replace(/\/$/, "");
  const authHeader = `Basic ${buildBasicAuth(wpConfig.username, wpConfig.appPassword)}`;

  const uniqueTitle = await ensureUniqueTitle(baseUrl, authHeader, clickTitle);
  const uniqueSlug = await ensureUniqueSlug(baseUrl, authHeader, draft.slug, uniqueTitle);
  const featuredMedia = await uploadFeaturedMedia({
    baseUrl,
    authHeader,
    imageUrl: news.ogImage,
    title: uniqueTitle
  });

  const meta = {};
  if (wpConfig.metaDescriptionKey) {
    meta[wpConfig.metaDescriptionKey] = draft.metaDescription;
  }
  if (wpConfig.seoTitleKey) {
    meta[wpConfig.seoTitleKey] = seoTitle || clickTitle;
  }

  const payload = {
    title: uniqueTitle,
    slug: uniqueSlug,
    content: createWordPressContent(news, draft, {
      sourceName,
      recentArticles,
      summaryText: summary,
      ctaText: draft.cta
    }),
    status: wpConfig.status,
    excerpt: clipText(summary, 180),
    categories: categoryId ? [categoryId] : wpConfig.categoryIds,
    tags: wpConfig.tagIds,
    ...(featuredMedia ? { featured_media: featuredMedia } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {})
  };

  const response = await withRetry(
    () =>
      axios.post(`${baseUrl}/wp-json/wp/v2/posts`, payload, {
        timeout: 22000,
        headers: { Authorization: authHeader }
      }),
    { label: "postToWordPress", retries: 5, baseDelayMs: 1200 }
  );

  return {
    id: response.data?.id,
    link: response.data?.link,
    slug: response.data?.slug,
    title: response.data?.title?.rendered,
    featuredMediaId: featuredMedia
  };
}

export async function postMinimalToWordPress({ wpConfig }) {
  const baseUrl = wpConfig.baseUrl.replace(/\/$/, "");
  const authHeader = `Basic ${buildBasicAuth(wpConfig.username, wpConfig.appPassword)}`;

  const payload = {
    title: "テストタイトル",
    content: "<p>テスト本文</p>",
    status: "publish"
  };

  const response = await withRetry(
    () =>
      axios.post(`${baseUrl}/wp-json/wp/v2/posts`, payload, {
        timeout: 15000,
        headers: { Authorization: authHeader }
      }),
    { label: "postMinimalToWordPress", retries: 3, baseDelayMs: 1000 }
  );

  return {
    id: response.data?.id,
    link: response.data?.link
  };
}
