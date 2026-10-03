const DEFAULT_DATA_URL = "https://xw9114.github.io/reader/data.json";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !["FETCH_LIBRARY", "FETCH_COVER"].includes(message.type)) return false;

  chrome.storage.local.get({ dataUrl: DEFAULT_DATA_URL }).then(async ({ dataUrl }) => {
    try {
      if (message.type === "FETCH_COVER") {
        const libraryUrl = new URL(dataUrl);
        const coverUrl = new URL(message.coverUrl, libraryUrl);
        if (coverUrl.origin !== libraryUrl.origin) throw new Error("封面地址不在 Reader 数据源中");
        const response = await fetch(coverUrl.href, { cache: "no-store" });
        if (!response.ok) throw new Error(`封面 HTTP ${response.status}`);
        const contentType = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
        if (!contentType.startsWith("image/")) throw new Error("封面响应不是图片");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 12 * 1024 * 1024) throw new Error("封面超过 12 MiB");
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        sendResponse({ ok: true, dataUrl: `data:${contentType};base64,${btoa(binary)}`, contentType });
        return;
      }
      const response = await fetch(dataUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.stories)) throw new Error("作品数据格式错误");
      sendResponse({ ok: true, payload, dataUrl });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  });

  return true;
});
