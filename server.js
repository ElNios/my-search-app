import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// API Keys 設定
const API_CONFIGS = [
  { key: process.env.API_KEY_1, cx: process.env.CX_1 },
  { key: process.env.API_KEY_2, cx: process.env.CX_2 }
];

let currentIndex = 0;

// 提供前端 index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

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

// Proxy 端點，過濾不能嵌入網站
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("缺少 url");

  const blockedHosts = ["pornhub.com", "xnxx.com"]; // 可自行擴充
  try {
    const urlObj = new URL(targetUrl);
    if (blockedHosts.some(host => urlObj.hostname.includes(host))) {
      return res.status(403).send("❌ 該網站不允許嵌入");
    }

    const response = await fetch(targetUrl);
    const contentType = response.headers.get("content-type");
    if (contentType) res.set("Content-Type", contentType);
    const body = await response.text();
    res.send(body);
  } catch (err) {
    console.error("Proxy Error:", err);
    res.status(500).send("代理失敗");
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
