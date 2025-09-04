// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "node-html-parser";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// 安全與限制設定
const MAX_RESOURCE_BYTES = 15 * 1024 * 1024; // 15 MB 資源上限 (避免吃光記憶體)
const FETCH_TIMEOUT_MS = 15_000; // fetch 超時 15s
const BLOCKED_HOSTS = ["pornhub.com", "xnxx.com"]; // 可擴充

// 讀取 API 設定 (從環境變數)
const API_CONFIGS = [
  { key: process.env.API_KEY_1, cx: process.env.CX_1 },
  { key: process.env.API_KEY_2, cx: process.env.CX_2 }
].filter(c => c.key && c.cx);

let currentIndex = 0;

// helper: timeout fetch (Node 18+ fetch)
async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// 根目錄提供 index.html（如果你要靜態放別處也行）
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 檢查是否可以嵌入 (HEAD 檢查 X-Frame-Options / CSP frame-ancestors)
app.get("/can-embed", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "缺少 url" });
  try {
    const urlObj = new URL(target);
    // 簡單 host block
    if (BLOCKED_HOSTS.some(h => urlObj.hostname.includes(h))) {
      return res.json({ embed: false, reason: "blocked_host" });
    }
    // HEAD request 取得 header
    let response;
    try {
      response = await fetchWithTimeout(target, { method: "HEAD" });
    } catch (err) {
      // 有些網站不接受 HEAD，改用 GET 但只取 headers (no body)
      response = await fetchWithTimeout(target, { method: "GET" });
    }
    const xfo = response.headers.get("x-frame-options");
    const csp = response.headers.get("content-security-policy") || response.headers.get("content-security-policy-report-only");
    // 判斷
    if (xfo) {
      const v = xfo.toLowerCase();
      if (v.includes("deny") || v.includes("sameorigin")) {
        return res.json({ embed: false, reason: "x-frame-options" });
      }
    }
    if (csp && /frame-ancestors/.test(csp)) {
      // 若 csp 中有 frame-ancestors 限制，視為不允許
      const frameAncestors = csp.match(/frame-ancestors[^;]*/i);
      if (frameAncestors && !/frame-ancestors\s+(\*|'self')/i.test(frameAncestors[0])) {
        return res.json({ embed: false, reason: "csp_frame_ancestors" });
      }
    }
    return res.json({ embed: true });
  } catch (err) {
    console.error("can-embed error:", err);
    return res.json({ embed: false, reason: "error" });
  }
});

// SEARCH: 呼叫 Google Custom Search（自動輪詢 API_KEYS），關閉 safe search 以接近原始
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "缺少關鍵字 q" });
  if (!API_CONFIGS.length) return res.status(500).json({ error: "未設定 API_KEYS/CX" });

  let result = null;
  for (let i = 0; i < API_CONFIGS.length; i++) {
    const { key, cx } = API_CONFIGS[currentIndex];
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(q)}&key=${key}&cx=${cx}&safe=off&num=10`;
    try {
      const r = await fetchWithTimeout(url);
      if (!r.ok) {
        if (r.status === 429) {
          currentIndex = (currentIndex + 1) % API_CONFIGS.length;
          continue;
        } else {
          const errBody = await r.text();
          result = { error: `google error ${r.status}`, body: errBody };
          break;
        }
      }
      result = await r.json();
      currentIndex = (currentIndex + 1) % API_CONFIGS.length;
      break;
    } catch (err) {
      console.error("search fetch error:", err);
      currentIndex = (currentIndex + 1) % API_CONFIGS.length;
    }
  }
  res.json(result || { error: "所有 API key 都失敗" });
});

// resource: 代理靜態資源 (image/css/js/font/video)
// - 會檢查大小限制、回傳正確 Content-Type
app.get("/resource", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("缺少 url");
  try {
    const response = await fetchWithTimeout(target);
    if (!response.ok) return res.status(502).send("resource fetch error");

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_RESOURCE_BYTES) {
      return res.status(413).send("resource too large");
    }

    // 讀取 buffer（注意：此方式會把資源放到記憶體，若要 stream 可改進）
    const ab = await response.arrayBuffer();
    if (ab.byteLength > MAX_RESOURCE_BYTES) return res.status(413).send("resource too large");

    res.set("Content-Type", contentType);
    // 允許 browser 從你 domain 請求這些資源
    res.set("Access-Control-Allow-Origin", "*");
    res.send(Buffer.from(ab));
  } catch (err) {
    console.error("resource error:", err);
    res.status(500).send("resource proxy error");
  }
});

// proxy: 針對 HTML 的代理 (會重寫資源 URL -> /resource)
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("缺少 url");
  try {
    const urlObj = new URL(target);

    // 區域 / 黑名單檢查
    if (BLOCKED_HOSTS.some(h => urlObj.hostname.includes(h))) {
      // 直接回 302 到外部網址（在iframe會變成在外部跳轉；但前端會先呼叫 /can-embed）
      return res.redirect(target);
    }

    // 先做 HEAD 檢查：若 X-Frame-Options/DENY 則告訴前端轉成新分頁（但前端會先 check /can-embed）
    let headOk = true;
    try {
      const head = await fetchWithTimeout(target, { method: "HEAD" });
      const xfo = head.headers.get("x-frame-options");
      const csp = head.headers.get("content-security-policy") || head.headers.get("content-security-policy-report-only");
      if (xfo && /deny|sameorigin/i.test(xfo)) headOk = false;
      if (csp && /frame-ancestors[^;]*/i.test(csp)) {
        const fa = csp.match(/frame-ancestors[^;]*/i)[0];
        if (!/frame-ancestors\s+(\*|'self')/i.test(fa)) headOk = false;
      }
    } catch (e) {
      // 如果 HEAD 失敗，不影響，會嘗試 GET
    }

    // GET HTML
    const response = await fetchWithTimeout(target);
    if (!response.ok) return res.status(502).send("proxy fetch failed");

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      // 非 HTML 的情況直接導到 /resource
      return res.redirect(`/resource?url=${encodeURIComponent(target)}`);
    }

    // 讀取 body (text)
    let body = await response.text();

    // 解析並重寫資源 URL（img[src], script[src], link[href], a[href]）
    const root = parse(body, { script: true, style: true, pre: true });

    // 加入 <base href="原始 URL"> 以便相對路徑正確
    const head = root.querySelector("head");
    if (head) {
      const baseTag = `<base href="${urlObj.origin}">`;
      head.insertAdjacentHTML("afterbegin", baseTag);
    }

    // 幫助函式：把相對 URL 轉絕對再重寫成 /resource?url=...
    const rewriteAttr = (el, attrName) => {
      const val = el.getAttribute(attrName);
      if (!val) return;
      try {
        const abs = new URL(val, urlObj.origin + urlObj.pathname).href;
        // 若該資源為 HTML page (a link)，請導到 /proxy?url=...；否則導到 /resource?url=...
        // we decide by extension
        const lower = abs.split("?")[0].toLowerCase();
        const isHtmlLike = lower.endsWith(".html") || lower.endsWith(".htm") || !path.extname(lower);
        if (attrName === "href" && el.tagName === "A") {
          el.setAttribute(attrName, `/proxy?url=${encodeURIComponent(abs)}`);
          el.setAttribute("target", "_self");
        } else if (isHtmlLike && (el.tagName === "A")) {
          el.setAttribute(attrName, `/proxy?url=${encodeURIComponent(abs)}`);
        } else {
          el.setAttribute(attrName, `/resource?url=${encodeURIComponent(abs)}`);
        }
      } catch (e) {
        // 忽略無效 URL
      }
    };

    // 處理 images
    root.querySelectorAll("img").forEach(img => rewriteAttr(img, "src"));
    // 處理 scripts
    root.querySelectorAll("script").forEach(s => {
      if (s.getAttribute("src")) rewriteAttr(s, "src");
    });
    // 處理 link (css, favicon)
    root.querySelectorAll("link").forEach(l => {
      if (l.getAttribute("href")) rewriteAttr(l, "href");
    });
    // 處理 a 標籤
    root.querySelectorAll("a").forEach(a => {
      if (a.getAttribute("href")) rewriteAttr(a, "href");
    });
    // 處理 video source, source tags
    root.querySelectorAll("source").forEach(s => {
      if (s.getAttribute("src")) rewriteAttr(s, "src");
      if (s.getAttribute("srcset")) s.setAttribute("srcset", s.getAttribute("srcset")); // leave for now
    });

    // 最後把修改後的 HTML 回傳
    const finalHtml = "<!doctype html>\n" + root.toString();
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(finalHtml);
  } catch (err) {
    console.error("proxy error:", err);
    res.status(500).send("代理失敗");
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
