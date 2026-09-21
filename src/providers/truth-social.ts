import * as cheerio from "cheerio";
import type { NewsArticle, NewsProvider } from "../types.js";

// The official truthsocial.com API blocks server-side/datacenter requests
// with 403 (Cloudflare-style bot protection), regardless of headers sent.
// This provider instead reads the public trumpstruth.org mirror, which
// renders Trump's Truth Social posts as plain server-side HTML with no
// such protection. Because it's an unofficial mirror site, its markup can
// change without notice -- if this provider starts silently returning zero
// posts, that's the first place to check.
const MIRROR_URL = "https://www.trumpstruth.org/";

export class TruthSocialTrumpProvider implements NewsProvider {
  readonly name = "truth-social-trump";
  constructor(readonly pollIntervalSeconds: number) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const response = await fetch(MIRROR_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html"
      }
    });
    if (!response.ok) throw new Error(`Truth Social mirror feed failed: ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);

    const articles: NewsArticle[] = [];
    $(".status").each((_, el) => {
      const status = $(el);

      const contentEl = status.find(".status__content").first();
      if (!contentEl.length) return; // media-only post (photo/video repost), no text to assess
      const text = contentEl.text().replace(/\s+/g, " ").trim();
      if (!text) return;

      const datetimeAttr = status.find(".status-info__meta time[datetime]").first().attr("datetime");
      if (!datetimeAttr) return;
      const publishedAt = new Date(datetimeAttr);
      if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) return;

      const externalUrl = status.find(".status__external-link").first().attr("href");
      const mirrorUrl = status.attr("data-status-url");
      const url = externalUrl || mirrorUrl || MIRROR_URL;
      const idMatch = url.match(/(\d+)\s*$/);
      const providerId = idMatch ? idMatch[1] : url;

      articles.push({
        provider: this.name,
        providerId,
        postId: providerId,
        author: "Donald Trump",
        title: "Donald Trump — Truth Social",
        summary: text,
        url,
        publishedAt,
        sourceName: "Truth Social @realDonaldTrump (via trumpstruth.org mirror)"
      });
    });

    return articles;
  }
}

