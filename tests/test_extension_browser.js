const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const fixtures = path.join(__dirname, "fixtures");

async function openFixture(browser, filename) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(pathToFileURL(path.join(fixtures, filename)).href);
  await page.locator("#reader-fanqie-importer").waitFor();
  return page;
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const chapterPage = await openFixture(browser, "fanqie-editor.html");
    const chapterPanel = chapterPage.locator("#reader-fanqie-importer");
    await chapterPanel.locator(".fill").click();
    assert.equal(await chapterPage.locator("#chapter-number").inputValue(), "1");
    assert.equal(await chapterPage.locator("#chapter-title").inputValue(), "测试");
    assert.equal(await chapterPage.locator(".chapter-editor p").count(), 2);
    await chapterPage.close();

    const shortStoryPage = await openFixture(browser, "fanqie-short-story-editor.html");
    const shortStoryPanel = shortStoryPage.locator("#reader-fanqie-importer");
    assert.equal(await shortStoryPanel.locator(".mode").textContent(), "短故事");
    assert.equal(await shortStoryPanel.locator(".fill").textContent(), "填入整篇短故事");
    assert.equal(await shortStoryPanel.locator(".chapter-row").isVisible(), false);
    await shortStoryPanel.locator(".fill").click();
    assert.equal(await shortStoryPage.locator(".short-story-title").textContent(), "测试短故事");
    assert.equal(await shortStoryPage.locator(".short-story-body p").count(), 4);
    assert.match(await shortStoryPage.locator(".short-story-body").innerText(), /开篇钩子[\s\S]*第1章 相遇/);
    assert.match(await shortStoryPanel.locator(".status").textContent(), /整篇正文已填入/);
    await shortStoryPage.close();

    const combinedPage = await openFixture(browser, "fanqie-short-story-combined-editor.html");
    const combinedPanel = combinedPage.locator("#reader-fanqie-importer");
    assert.equal(await combinedPanel.locator(".mode").textContent(), "短故事");
    await combinedPanel.locator(".fill").click();
    assert.equal(await combinedPage.locator(".short-story-editor h1").textContent(), "合并编辑器故事");
    assert.equal(await combinedPage.locator(".short-story-editor p").count(), 3);
    await combinedPage.close();
  } finally {
    await browser.close();
  }
  process.stdout.write("Extension browser fixtures passed.\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
