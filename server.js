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

// ---------- config ----------
const API_CONFIGS = [
  { key: process.env.API_KEY_1, cx: process.env.CX_1 },
  { key: process.env.API_KEY_2, cx: process.env.CX_2 }
].filter(x => x.key && x.cx);

const BLOCKED_HOSTS = (process.env.BLOCKED_HOSTS || "pornhub.com,xnxx.com").split(",").map(s=>s.trim()).filter(Boolean);
const MAX_RESOURCE_BYTES = parseInt(process.env.MAX_RESOURCE_BYTES || String(15 * 1024 * 1024), 10); // 15MB default
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10); // 15s
// ----------------------------

function timeoutFetch(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

// serve front page if present
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------- can-embed: HEAD check ----------
app.get("/can-embed", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ ok:false, msg: "缺少 url" });
  try {
    const u = new URL(target);
    if (BLOCKED_HOSTS.some(h => u.hostname.includes(h))) return res.json({ ok:true, embed:false, reason:"blocked_host" });

    let head;
    try {
      head = await timeoutFetch(target, { method: "HEAD" });
    } catch (e) {
      // HEAD 不通再用 GET 但不讀 body
      head = await timeoutFetch(target, { method: "GET" });
    }
    const xfo = head.headers.get("x-frame-options") || "";
    const csp = head.headers.get("content-security-policy") || head.headers.get("content-security-policy-report-only") || "";

    if (/deny|sameorigin/i.test(xfo)) return res.json({ ok:true, embed:false, reason:"x-frame-options" });
    if (/frame-ancestors[^;]*/i.test(csp)) {
      // 如果 csp 有 frame-ancestors 且不是允許所有，視為不允許
      const fa = (csp.match(/frame-ancestors[^;]*/i)||[])[0] || "";
      if (!/frame-ancestors\s+(\*|'self')/i.test(fa)) return res.json({ ok:true, embed:false, reason:"csp_frame_ancestors" });
    }

    return res.json({ ok:true, embed:true });
  } catch (err) {
    console.error("can-embed error:", err);
    return res.json({ ok:false, embed:false, reason:"error" });
  }
});

// ---------- search: call Google Custom Search, safer error handling ----------
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ ok:false, msg:"缺少關鍵字 q" });
  if (!API_CONFIGS.length) return res.status(500).json({ ok:false, msg:"尚未設定 API_KEY/CX" });

  let out = null;
  const tries = API_CONFIGS.length;
  for (let i=0;i<tries;i++) {
    const cfg = API_CONFIGS[currentIndex()];
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(q)}&key=${cfg.key}&cx=${cfg.cx}&safe=off&num=10`;
    try {
      const r = await timeoutFetch(url);
      if (!r.ok) {
        if (r.status === 429) {
          // rotate and retry
          rotateIndex();
          continue;
        } else {
          const txt = await r.text().catch(()=>"");
          out = { ok:false, msg:`google api error ${r.status}`, body: txt };
          break;
        }
      }
      const j = await r.json();
      out = { ok:true, data: j };
      rotateIndex();
      break;
    } catch (err) {
      console.error("search fetch error:", err);
      rotateIndex();
    }
  }
  if (!out) out = { ok:false, msg:"所有 API key 或網路皆失敗" };
  res.json(out);
});

// helper rotation
let _idx = 0;
function currentIndex(){ return _idx % API_CONFIGS.length; }
function rotateIndex(){ _idx = (_idx + 1) % Math.max(1, API_CONFIGS.length); }

// ---------- resource proxy: images/js/css/video (returns bytes) ----------
app.get("/resource", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("缺少 url");
  try {
    const r = await timeoutFetch(target);
    if (!r.ok) return res.status(502).send("resource fetch failed");

    const ct = r.headers.get("content-type") || "application/octet-stream";
    const cl = r.headers.get("content-length");
    if (cl && parseInt(cl,10) > MAX_RESOURCE_BYTES) return res.status(413).send("resource too large");

    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAX_RESOURCE_BYTES) return res.status(413).send("resource too large");

    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=300"); // 緩存 5 分
    res.set("Access-Control-Allow-Origin", "*");
    return res.send(Buffer.from(ab));
  } catch (err) {
    console.error("resource error:", err);
    // 若是 image 可回傳 1x1 transparent png，避免 broken image
    const png1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAn8B9k3g3wAAAABJRU5ErkJggg==",
      "base64"
    );
    res.set("Content-Type","image/png");
    return res.status(200).send(png1x1);
  }
});

// ---------- proxy: HTML proxy with rewriting; error -> friendly HTML that links to original ----------
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("缺少 url");
  try {
    const u = new URL(target);
    if (BLOCKED_HOSTS.some(h => u.hostname.includes(h))) {
      // 直接給前端轉到外部（讓使用者在新分頁開啟）
      return res.send(`<html><body><script>window.top.location.href=${JSON.stringify(target)};</script></body></html>`);
    }

    // HEAD-check X-Frame-Options/CSP
    try {
      const h = await timeoutFetch(target, { method: "HEAD" });
      const xfo = h.headers.get("x-frame-options") || "";
      const csp = h.headers.get("content-security-policy") || h.headers.get("content-security-policy-report-only") || "";
      if (/deny|sameorigin/i.test(xfo) || (/frame-ancestors[^;]*/i.test(csp) && !/frame-ancestors\s+(\*|'self')/i.test(csp.match(/frame-ancestors[^;]*/i)[0]||""))) {
        // 不允許嵌入
        return res.send(`<html><body><script>window.top.location.href=${JSON.stringify(target)};</script></body></html>`);
      }
    } catch (e) {
      // 無視 HEAD 錯誤，繼續嘗試 GET
    }

    const r = await timeoutFetch(target);
    if (!r.ok) {
      // friendly HTML with link to open original
      return res.status(200).send(`<html><body style="font-family:Arial;padding:20px;">
        <h3>無法在內嵌顯示此頁面</h3>
        <p>後端抓取目標網站發生錯誤（狀態 ${r.status}）。</p>
        <p><a href="${target}" target="_blank" rel="noopener">在新分頁打開原始網站</a></p>
        </body></html>`);
    }

    const contentType = r.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      // 非 HTML 直接 redirect 到 /resource（會由瀏覽器請求並取得 bytes）
      return res.redirect(`/resource?url=${encodeURIComponent(target)}`);
    }

    // 讀 body
    let body = await r.text();

    // parse and rewrite resources to /resource or anchors to /proxy
    const root = parse(body, { script: true, style: true, pre: true });

    // add base tag so relative URLs resolve
    const head = root.querySelector("head");
    if (head) head.insertAdjacentHTML("afterbegin", `<base href="${u.origin}">`);

    const rewrite = (el, attr) => {
      const v = el.getAttribute(attr);
      if (!v) return;
      try {
        const abs = new URL(v, u.href).href;
        const lower = abs.split("?")[0].toLowerCase();
        const ext = path.extname(lower);
        const isHtmlLike = ext === "" || ext === ".html" || ext === ".htm";
        if (el.tagName === "A" && attr === "href") {
          el.setAttribute("href", `/proxy?url=${encodeURIComponent(abs)}`);
          el.setAttribute("target", "_self");
        } else if (isHtmlLike && el.tagName === "A") {
          el.setAttribute("href", `/proxy?url=${encodeURIComponent(abs)}`);
        } else {
          el.setAttribute(attr, `/resource?url=${encodeURIComponent(abs)}`);
        }
      } catch (e) {
        // ignore
      }
    };

    root.querySelectorAll("img").forEach(img => rewrite(img,"src"));
    root.querySelectorAll("script").forEach(s => s.getAttribute("src") && rewrite(s,"src"));
    root.querySelectorAll("link").forEach(l => l.getAttribute("href") && rewrite(l,"href"));
    root.querySelectorAll("a").forEach(a => a.getAttribute("href") && rewrite(a,"href"));
    root.querySelectorAll("source").forEach(s => s.getAttribute("src") && rewrite(s,"src"));

    const finalHtml = "<!doctype html>\n" + root.toString();
    res.set("Content-Type","text/html; charset=utf-8");
    return res.send(finalHtml);
  } catch (err) {
    console.error("proxy error:", err);
    return res.status(500).send(`<html><body style="font-family:Arial;padding:20px;">
      <h3>代理失敗</h3>
      <p>後端處理代理時發生錯誤。</p>
      <p><a href="${req.query.url || '#'}" target="_blank" rel="noopener">在新分頁打開原始網站</a></p>
    </body></html>`);
  }
});

app.listen(PORT, () => console.log(`✅ Server listening on ${PORT}`));
