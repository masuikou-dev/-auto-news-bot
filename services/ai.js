import axios from "axios";
import { withRetry } from "../utils/retry.js";

function clipText(text, maxLength) {
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeClickTitle(rawTitle, fallbackTitle) {
  const line = String(rawTitle ?? "")
    .split(/\r?\n/)
    .map(item => item.trim())
    .find(item => item.length > 0);

  const cleaned = (line ?? "").replace(/^[-・\d\s.]+/, "").trim();
  if (!cleaned) return clipText(fallbackTitle ?? "ニュース速報", 40);
  if (cleaned.length > 40) return `${cleaned.slice(0, 40)}…`;
  if (cleaned.length < 20) return clipText(fallbackTitle ?? cleaned, 40);
  return cleaned;
}

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeInternalLinks(rawLinks) {
  if (!Array.isArray(rawLinks)) return [];

  return rawLinks
    .map(item => ({
      title: String(item?.title ?? "").trim(),
      url: String(item?.url ?? "").trim()
    }))
    .filter(item => item.title.length > 0 && item.url.length > 0)
    .filter(item => /^(\/|https?:\/\/)/.test(item.url))
    .filter(item => !/\/related(-article)?\/(?:\d+|background|why-now)/.test(item.url))
    .filter(item => !/\/related-article-\d+/.test(item.url))
    .slice(0, 3);
}

function normalizeCategory(category) {
  const normalized = String(category ?? "world").toLowerCase().trim();
  const allowed = new Set(["it", "economy", "politics", "entertainment", "world"]);
  return allowed.has(normalized) ? normalized : "world";
}

function getCategoryPromptProfile(category) {
  const current = normalizeCategory(category);

  const profiles = {
    it: {
      titleFocus: "ワクワク感・未来感・技術の可能性を強調し、自然に気になる切り口を作る。",
      xTone: "驚きと発見をベースに、生活がどう変わるかを会話調で伝える。"
    },
    economy: {
      titleFocus: "お金・影響・損得を強調し、読者が自分事化しやすい視点を入れる。",
      xTone: "実利と影響を、家計・企業・市場の観点でわかりやすく示す。"
    },
    politics: {
      titleFocus: "対立・意図・駆け引きを強調しつつ、断定を避けて疑問を残す。",
      xTone: "政策や思惑の文脈を、読者に語りかけるように整理して伝える。"
    },
    entertainment: {
      titleFocus: "感情・共感・驚きを強調し、思わず会話したくなるトーンにする。",
      xTone: "共感と驚きを中心に、人間味のある自然なリアクションで伝える。"
    },
    world: {
      titleFocus: "不安・危機感・インパクトを強調しつつ、状況理解につながる問いを含める。",
      xTone: "危機感と状況把握を両立し、落ち着いた会話調で伝える。"
    }
  };

  return { category: current, ...profiles[current] };
}

async function requestChatCompletion({ apiKey, model, messages, label }) {
  const response = await withRetry(
    () =>
      axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model,
          messages
        },
        {
          timeout: 22000,
          headers: {
            Authorization: `Bearer ${apiKey}`
          }
        }
      ),
    { label }
  );

  return response.data.choices[0].message.content;
}

export async function summarize({ apiKey, model, sourceText }) {
  return requestChatCompletion({
    apiKey,
    model,
    label: "summarize",
    messages: [
      {
        role: "system",
        content: `
あなたは「わかりやすく話してくれるニュース解説者」です。

単なる要約は禁止。読者に語りかけるように書いてください。

文章ルール：
・1文は最大60文字。長い場合は必ず2〜3文に分ける
・1段落は最大3行まで
・「説明」ではなく「会話」で書く
・難しい言葉は必ずかみ砕く
・断定しすぎない（〜と見られる、〜かもしれません）
・積極的に使う：「簡単に言うと」「つまり〜」「ここがポイントで」「気になるのは〜」「ちょっと面白いのが〜」

以下の形式で出力。各項目は必ず改行して分割：

・一言要約
→ 1文のみ。インパクト重視。60文字以内。

・本質
→ 1文目：短くインパクト
→ 2文目：「つまり〜ということです」
→ 3文目：補足（必要な場合のみ）

・なぜ重要か
→ 各1〜2文。「〜という点で重要です」の形で。

・気になるポイント
→ 1〜2文。読者目線の疑問。

・今後の焦点
→ 1〜2文。「今後注目なのは〜です」で締める。
`
      },
      {
        role: "user",
        content: clipText(sourceText, 3000)
      }
    ]
  });
}

export async function generateClickTitle({ apiKey, model, title, contentSnippet, category = "world" }) {
  const profile = getCategoryPromptProfile(category);

  const content = await requestChatCompletion({
    apiKey,
    model,
    label: "generateClickTitle",
    messages: [
      {
        role: "system",
        content: `
SEO＋クリック誘導型のタイトルを1つ作ってください。

条件：
・28〜40文字
・数字（円・%・件・倍など）を可能な限り入れる
・固有キーワードを可能な限り含める（例：日経平均・金利・原油・AI・円安）
・不安またはベネフィットを明示する
・結論を言い切らず、続きを読ませる構造
・媒体名・括弧付き補足は不要
・カテゴリ方針: ${profile.titleFocus}

良い例：
・「日経平均600円急落、原油高と金利上昇で生活への影響は？」
・「円安が150円突破、物価と賃金にどう影響するのか」
・「GPT-5が公開、私たちの仕事はどう変わる？」

悪い例（禁止）：
・「これって結局どういうこと？」（キーワードなし）
・「意外と知られてないポイント」（具体性ゼロ）

出力はタイトルのみ
`
      },
      {
        role: "user",
        content: clipText(`${title}\n${contentSnippet ?? ""}`, 2000)
      }
    ]
  });

  return normalizeClickTitle(content, title);
}

export async function generateXPost({ apiKey, model, news, category = "world" }) {
  const profile = getCategoryPromptProfile(category);
  const sourceText = clipText(`${news.title}\n${news.contentSnippet ?? ""}\n${news.articleText ?? ""}`, 3000);

  return requestChatCompletion({
    apiKey,
    model,
    label: "generateXPost",
    messages: [
      {
        role: "system",
        content: `
バズりやすいX（Twitter）投稿を書いてください。

フォーマット（必ずこの4段落構成）：
① 驚き or 違和感（1〜2行、感情むき出しでOK）
② 事実＋数字（1〜2行、具体的な数字を必ず入れる）
③ 解釈・つまりどういうことか（1〜2行）
④ 質問 or 共感を引く一言（「みんなどう思う？」「これ他人事じゃない」など）

条件：
・各段落の間に空行を入れる
・合計140〜180文字
・数字・固有名詞を必ず含める
・カテゴリ方針: ${profile.xTone}
・断定しすぎない
・説明文にならない、会話のテンポで

良い例：
「え、また下げてる…

日経平均が600円以上急落
原油高＋金利上昇が原因らしい

これ、ガソリン代とか
普通に影響出るやつじゃない？

みんなどう思う？」

出力は投稿本文のみ
`
      },
      {
        role: "user",
        content: `ニュース内容:\n${sourceText}`
      }
    ]
  });
}

export async function generateSeoTitle({ apiKey, model, title, contentSnippet, category = "world" }) {
  const profile = getCategoryPromptProfile(category);

  const content = await requestChatCompletion({
    apiKey,
    model,
    label: "generateSeoTitle",
    messages: [
      {
        role: "system",
        content: `
SEOで上位表示かつクリックされる日本語タイトルを1つ作ってください。

【条件】
・28〜42文字
・固有キーワードを2つ以上必ず含める（例：OpenAI、AWS、日経平均、金利、円安など）
・具体的な数字を1つ以上必ず含める（例：2倍、3万人、150円、600円など）
・「疑問形」または「続きが気になる構造」にする（例：〜とは？ 〜の理由とは なぜ〜なのか）
・「何が起きたか」と「読むメリット」を含める
・検索意図を反映（「原因」「影響」「とは」「解説」など）
・煽りすぎない、誇張しない（激変・衝撃などは禁止）
・日付は絶対に含めない
・カテゴリ方針: ${profile.titleFocus}

【構成ルール（重要）】
前半：出来事（何が起きたか）
後半：価値（何が分かるか）

【良い例】
・「任天堂の利益2倍の理由とは？世界で勝つ戦略を解説」
・「日経平均が600円下落、原因と株価・生活への影響を解説」
・「OpenAIがAWS展開、マルチクラウド化で何が変わるのか」
・「円安150円突破、家計と企業への影響はどうなる？」

【悪い例（禁止）】
・「任天堂の海外成功要因と日本ゲーム企業の利益拡大に与える影響を解説」（数字なし・疑問形なし）
・「これってどういうこと？」（キーワードなし）
・「最新情報まとめ」（曖昧すぎ）

出力はタイトルのみ
`
      },
      {
        role: "user",
        content: clipText(`${title}\n${contentSnippet ?? ""}`, 2000)
      }
    ]
  });

  return normalizeClickTitle(content, title);
}

export async function generateArticleDraft({ apiKey, model, news }) {
  const sourceText = clipText(`${news.title}\n${news.contentSnippet ?? ""}\n${news.articleText ?? ""}`, 3000);

  const content = await requestChatCompletion({
    apiKey,
    model,
    label: "generateArticleDraft",
    messages: [
      {
        role: "system",
        content: `
自然な会話調を取り入れたニュース記事を作成してください。
以下のJSONのみを出力してください。

{
  "conclusion": "まず結論（120〜180文字）",
  "whatItMeans": "これってどういうこと？（120〜220文字）",
  "keyPoints": "ここがポイント（120〜220文字）",
  "impact": "ちょっと気になるのは（120〜220文字、違和感・疑問のみ）",
  "future": "今後どうなる？（120〜220文字）",
  "internalLinks": [
    {"title": "関連記事タイトル", "url": "/related-article-1"},
    {"title": "関連記事タイトル", "url": "/related-article-2"}
  ],
  "cta": "最後に読者の行動を自然に促す一言（80〜140文字）",
  "summary": "まとめ（80〜140文字）",
  "metaDescription": "120文字前後のmeta description",
  "slug": "英語またはローマ字のslug（lowercase-hyphen）"
}

制約：
・JSON形式は維持
・「説明」ではなく「会話」で書く。読者に語りかけるトーン
・1文は最大60文字。長い場合は2〜3文に分ける
・1段落は最大3行まで
・難しい言葉は必ずかみ砕く
・断定しすぎない（〜かもしれません、〜と見られます）
・積極的に使う：「簡単に言うと」「つまり〜」「ここがポイントで」「気になるのは〜」「ちょっと面白いのが〜」
・impactフィールドは「ちょっと気になるのは〜」という書き出しで疑問・懸念を提示する
・conclusionは冒頭3行を意識（1行目:驚き/違和感、2行目:事実、3行目:読む理由）
・keyPointsは箇条書きっぽく短文を並べ、最後を一言の本質で締める
・internalLinksは必ず2〜3件生成（疑問を解決する流れ）
・ctaは自然な行動導線にする（押し売り禁止）
・「数字の挿入」が必須：conclusion・whatItMeans・keyPoints・impactのいずれかに、ニュース本文中の具体的な数字（人数・金額・割合・件数など）を最低1〜2箇所自然に組み込む。数字がない場合は「〜規模」「〜程度」などで補う
`
      },
      {
        role: "user",
        content: `ニュース内容:\n${sourceText}`
      }
    ]
  });

  const parsed = parseJsonFromText(content) ?? {};
  const normalizedLinks = normalizeInternalLinks(parsed.internalLinks);

  return {
    conclusion: clipText(parsed.conclusion ?? news.contentSnippet ?? news.title ?? "", 190),
    whatItMeans: clipText(parsed.whatItMeans ?? "少し分かりにくいですが、簡単に言うと生活や業界の前提が動き始めた可能性があります。", 230),
    keyPoints: clipText(parsed.keyPoints ?? "・ここがポイントで、最初の変化より背景の流れが重要です。\n・簡単に言うと、今後の判断基準が変わる可能性があります。\n・つまり、短期の話題より次の一手を見ることが大事です。", 260),
    impact: clipText(parsed.impact ?? "ちょっと気になるのは、利用者と事業者で受け止め方が分かれる点です。", 230),
    future: clipText(parsed.future ?? "今後は追加発表や運用ルールの変化次第で、評価が変わる可能性があります。", 230),
    internalLinks: normalizedLinks,
    cta: clipText(parsed.cta ?? "このテーマは続報で見え方が変わりやすいです。気になる方は関連記事もチェックしてみてください。", 170),
    summary: clipText(parsed.summary ?? "つまり、目先の話題だけでなく次の変化まで見ておくのが大事ということです。", 170),
    metaDescription: clipText(parsed.metaDescription ?? parsed.summary ?? "最新ニュースの要点をわかりやすく解説。", 130),
    slug: String(parsed.slug ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70)
  };
}
