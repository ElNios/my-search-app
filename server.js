import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// Google API 設定
const API_CONFIGS = [
  { key: process.env.API_KEY_1, cx: process.env.CX_1 },
  { key: process.env.API_KEY_2, cx: process.env.CX_2 }
];
let currentIndex = 0;

// 搜尋 API
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "缺少關鍵字 q" });

  let result;
  for (let i = 0; i < API_CONFIGS.length; i++) {
    const { key, cx } = API_CONFIGS[currentIndex];
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${key}&cx=${cx}&safe=off`;

    try {
      const response = await fetch(url);
      if (!response.ok && response.status === 429) {
        currentIndex = (currentIndex + 1) % API_CONFIGS.length;
        continue;
      }
      result = await response.json();
      currentIndex = (currentIndex + 1) % API_CONFIGS.length;
      break;
    } catch (err) {
      console.error(err);
    }
  }

  res.json(result || { error: "所有 API key 都失敗" });
});

// Proxy 端點
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("缺少 url");

  const blockedHosts = ["pornhub.com", "xnxx.com"];
  try {
    const urlObj = new URL(targetUrl);

    // 黑名單直接新分頁
    if (blockedHosts.some(host => urlObj.hostname.includes(host))) {
      return res.json({ openInNewTab: true, url: targetUrl });
    }

    const response = await fetch(targetUrl);
    const xFrame = response.headers.get("x-frame-options") || "";
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();

    // 判斷禁止嵌入或含圖片/影片/iframe
    if (xFrame.match(/DENY|SAMEORIGIN/i) || /<img|<video|<iframe/i.test(body)) {
      return res.json({ openInNewTab: true, url: targetUrl });
    }

    if (contentType) res.set("Content-Type", contentType);
    res.send(body);

  } catch (err) {
    console.error("Proxy Error:", err);
    res.status(500).send("代理失敗");
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
