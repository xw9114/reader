const DEFAULT_DATA_URL = "https://xw9114.github.io/reader/data.json";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "FETCH_LIBRARY") return false;

  chrome.storage.local.get({ dataUrl: DEFAULT_DATA_URL }).then(async ({ dataUrl }) => {
    try {
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
