// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import puppeteer from "puppeteer";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const API_CONFIGS = [
  { key: process.env.API_KEY_1, cx: process.env.CX_1 },
  { key: process.env.API_KEY_2, cx: process.env.CX_2 }
];

let currentIndex = 0;

// 搜尋 API
app.get("/search", async (req, res) => {
  const query = req.query.q;
  const type = req.query.type || "web";
  if (!query) return res.status(400).json({ error: "缺少關鍵字 q" });

  let result;
  for (let i = 0; i < API_CONFIGS.length; i++) {
    const { key, cx } = API_CONFIGS[currentIndex];
    let url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${key}&cx=${cx}&safe=off`;
    if (type === "image") url += "&searchType=image";

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

// Puppeteer proxy 抓取頁面多媒體
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("缺少 url");

  try {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: "networkidle2" });

    const imgs = await page.$$eval("img", imgs => imgs.map(i => i.src));
    const videos = await page.$$eval("video", vids => vids.map(v => v.src));
    const iframes = await page.$$eval("iframe", frames => frames.map(f => f.src));

    let html = "<html><body>";
    imgs.forEach(src => html += `<img src="${src}" style="max-width:100%;"><br>`);
    videos.forEach(src => html += `<video controls src="${src}" style="max-width:100%;"></video><br>`);
    iframes.forEach(src => html += `<iframe src="${src}" allowfullscreen style="width:100%;height:400px;"></iframe><br>`);
    html += "</body></html>";

    await browser.close();
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("抓取失敗");
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
