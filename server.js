app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("缺少 url");

  // 過濾明顯禁止嵌入的網站
  const blockedHosts = ["pornhub.com", "xnxx.com"];
  try {
    const urlObj = new URL(targetUrl);
    if (blockedHosts.some(host => urlObj.hostname.includes(host))) {
      return res.status(403).send("❌ 該網站不允許嵌入");
    }

    const response = await fetch(targetUrl);
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();

    // 判斷是否有圖片或影片標籤
    const hasMedia = /<img|<video|<iframe/i.test(body);

    // 如果有圖片或影片，告訴前端需要開新分頁
    if (hasMedia) {
      res.json({ openInNewTab: true, url: targetUrl });
    } else {
      // 只含文字或簡單 HTML，返回完整 HTML
      if (contentType) res.set("Content-Type", contentType);
      res.send(body);
    }
  } catch (err) {
    console.error("Proxy Error:", err);
    res.status(500).send("代理失敗");
  }
});
