/**
 * Web Fetch Tool — 网页内容提取（阅读模式）
 * 提取正文内容，去除广告/导航/脚本
 */

import { registry, ToolDefinition } from "./tool-registry.js";

const webFetchDef: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch and extract readable content from a web page. Returns title, content, and links.",
  category: "web",
  parameters: [
    { name: "url", type: "string", description: "URL to fetch", required: true },
    { name: "max_length", type: "number", description: "Max content length in chars", default: 8000 },
    { name: "extract_links", type: "boolean", description: "Also extract all links", default: false },
  ],
};

async function webFetchExecute(params: Record<string, unknown>) {
  const url = String(params.url || "").trim();
  const maxLength = Number(params.max_length || 8000);
  const extractLinks = Boolean(params.extract_links);

  if (!url) {
    return { error: "URL is required" };
  }

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) {
      return { error: `HTTP ${resp.status}: ${resp.statusText}` };
    }

    const contentType = resp.headers.get("content-type") || "";
    const html = await resp.text();

    // Extract readable content
    const extracted = extractReadableContent(html, maxLength);

    const result: Record<string, unknown> = {
      url,
      title: extracted.title,
      content: extracted.content,
      content_length: extracted.content.length,
      excerpt: extracted.content.slice(0, 200) + "...",
    };

    if (extractLinks) {
      result.links = extractAllLinks(html, url);
    }

    return result;
  } catch (err: any) {
    return { error: `Fetch failed: ${err.message}` };
  }
}

function extractReadableContent(html: string, maxLength: number): { title: string; content: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]) : "";

  // Remove script, style, nav, header, footer, aside, advertisement
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<\/?(div|span)[^>]*class="[^"]*(?:ad|ads|advertisement|banner|popup|sidebar|comment)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Try to find main/article content
  const articleMatch = cleaned.match(/<article[\s\S]*?<\/article>/i) ||
                       cleaned.match(/<main[\s\S]*?<\/main>/i) ||
                       cleaned.match(/<div[^>]*class="[^"]*(?:content|article|post|entry|main)[^"]*"[^>]*>[\s\S]*?<\/div>/i);

  let content = "";
  if (articleMatch) {
    content = stripHtml(articleMatch[0]);
  } else {
    // Fallback: extract all paragraphs and headings
    const textMatches = cleaned.match(/<(p|h[1-6]|li)[^>]*>[\s\S]*?<\/\1>/gi);
    if (textMatches) {
      content = textMatches.map((m) => stripHtml(m)).join("\n\n");
    } else {
      content = stripHtml(cleaned);
    }
  }

  // Clean up whitespace
  content = content
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  // Truncate if too long
  if (content.length > maxLength) {
    content = content.slice(0, maxLength) + "\n\n[Content truncated...]";
  }

  return { title, content };
}

function extractAllLinks(html: string, baseUrl: string): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();

  const regex = /<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    const text = stripHtml(match[2]).trim();

    // Skip anchors, javascript, mailto
    if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
      continue;
    }

    // Resolve relative URLs
    let fullUrl: string;
    try {
      fullUrl = new URL(href, baseUrl).toString();
    } catch (err) { console.error("[web-fetch] Error:", err);
      continue;
    }

    if (!seen.has(fullUrl) && text.length > 0) {
      seen.add(fullUrl);
      links.push({ text: text.slice(0, 100), url: fullUrl });
    }
  }

  return links.slice(0, 50);
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Registration ────────────────────────────────────────────────

export function registerWebFetchTool(): void {
  registry.register(webFetchDef, webFetchExecute);
}
