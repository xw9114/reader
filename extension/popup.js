const status = document.querySelector("#status");

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  const url = tab?.url || "";
  const platform = /^https:\/\/zuozhe\.qimao\.com\//.test(url)
    ? "七猫"
    : /^(https:\/\/fanqienovel\.com\/main\/writer|https:\/\/writer\.muyewx\.com\/)/.test(url)
      ? "番茄"
      : null;
  status.textContent = platform
    ? `助手已在当前${platform}作者页面运行。请使用页面右下角的导入面板。`
    : "当前不是已支持的作者后台页面。";
});

document.querySelector("#openFanqie").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://fanqienovel.com/main/writer/" });
});

document.querySelector("#openQimao").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://zuozhe.qimao.com/front/index" });
});
