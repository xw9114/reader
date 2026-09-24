const status = document.querySelector("#status");

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  const supported = /^(https:\/\/fanqienovel\.com\/main\/writer|https:\/\/writer\.muyewx\.com\/)/.test(tab?.url || "");
  status.textContent = supported
    ? "助手已在当前番茄作者页面运行。请使用页面右下角的导入面板。"
    : "当前不是番茄作者后台页面。";
});

document.querySelector("#openWriter").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://fanqienovel.com/main/writer/" });
});
