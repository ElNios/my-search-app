import express from "express";
import fetch from "node-fetch";
import { parse } from "node-html-parser";
import cors from "cors";
import dotenv from "dotenv";
import { URL } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// Google API keys & CX
const API_KEYS = process.env.API_KEYS ? process.env.API_KEYS.split(",") : [];
const CXS = process.env.CXS ? process.env.CXS.split(",") : [];
let currentKeyIndex = 0;

// 禁止嵌入的 Host
const BLOCKED_HOSTS = process.env.BLOCKED_HOSTS ? process.env.BLOCKED_HOSTS.split(",") : [];

// ---------- Google 搜尋 ----------
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "缺少關鍵字 q" });

  let result;
  for (let i = 0; i < API_KEYS.length; i++) {
    const key = API_KEYS[currentKeyIndex];
    const cx = CXS[currentKeyIndex % CXS.length];
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${key}&cx=${cx}&safe=off&num=10&fields=items(title,link,snippet)`;
    try {
      const response = await fetch(url);
      if (response.status === 429) {
        currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
        continue;
      }
      result = await response.json();
      break;
    } catch (err) {
      console.error(err);
    }
  }
  res.json(result?.items || []);
});

// ---------- 檢查能否嵌入 ----------
app.get("/can-embed", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.json({ allow: false });
  try {
    const urlObj = new URL(target);
    if (BLOCKED_HOSTS.includes(urlObj.host)) return res.json({ allow: false });

    const response = await fetch(target, { method: "HEAD" });
    const xFrame = response.headers.get("x-frame-options");
    const csp = response.headers.get("content-security-policy") || "";
    if (xFrame?.toLowerCase().includes("deny") || csp.includes("frame-ancestors")) {
      return res.json({ allow: false });
    }
    res.json({ allow: true });
  } catch (e) {
    res.json({ allow: false });
  }
});

// ---------- 資源代理 ----------
app.get("/resource", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url");
  try {
    const response = await fetch(target);
    res.set("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    response.body.pipe(res);
  } catch (e) {
    res.status(500).send("Error fetching resource");
  }
});

// ---------- 網頁代理 ----------
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url");
  try {
    const allowRes = await fetch(`http://localhost:${PORT}/can-embed?url=${encodeURIComponent(target)}`);
    const { allow } = await allowRes.json();
    if (!allow) return res.redirect(target);

    const response = await fetch(target);
    let html = await response.text();

    const root = parse(html);

    root.querySelectorAll("*").forEach(el => {
      ["src", "href", "srcset", "poster"].forEach(attr => {
        const val = el.getAttribute(attr);
        if (!val) return;
        try {
          const abs = new URL(val, target).href;
          if (el.tagName === "A") {
            el.setAttribute("href", `/proxy?url=${encodeURIComponent(abs)}`);
            el.setAttribute("target","_self");
          } else {
            el.setAttribute(attr, `/resource?url=${encodeURIComponent(abs)}`);
          }
        } catch (e) {}
      });
    });

    res.send(root.toString());
  } catch (e) {
    res.status(500).send("Error loading page");
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
