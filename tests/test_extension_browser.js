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
    assert.equal(await shortStoryPanel.locator(".mode").textContent(), "番茄 · 短故事");
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
    assert.equal(await combinedPanel.locator(".mode").textContent(), "番茄 · 短故事");
    await combinedPanel.locator(".fill").click();
    assert.equal(await combinedPage.locator(".short-story-editor h1").textContent(), "合并编辑器故事");
    assert.equal(await combinedPage.locator(".short-story-editor p").count(), 3);
    await combinedPage.close();

    const qimaoWorkPage = await openFixture(browser, "qimao-work-editor.html");
    const qimaoWorkPanel = qimaoWorkPage.locator("#reader-fanqie-importer");
    assert.equal(await qimaoWorkPanel.locator(".mode").textContent(), "七猫 · 作品信息");
    assert.equal(await qimaoWorkPanel.locator(".fill").textContent(), "填入作品信息");
    assert.equal(await qimaoWorkPanel.locator(".chapter-row").isVisible(), false);
    await qimaoWorkPanel.locator(".fill").click();
    assert.equal(await qimaoWorkPage.locator("#work-title").inputValue(), "测试七猫作品");
    assert.match(await qimaoWorkPage.locator("#work-summary").inputValue(), /^这是用于七猫作品简介/);
    assert.ok((await qimaoWorkPage.locator("#work-summary").inputValue()).length <= 500);
    assert.equal(await qimaoWorkPage.evaluate(() => window.__QIMAO_CONFIRM_CLICKS__), 0);
    assert.match(await qimaoWorkPanel.locator(".status").textContent(), /作品名称和简介草稿已填入/);
    await qimaoWorkPage.close();

    const qimaoChapterPage = await openFixture(browser, "qimao-chapter-editor.html");
    const qimaoChapterPanel = qimaoChapterPage.locator("#reader-fanqie-importer");
    assert.equal(await qimaoChapterPanel.locator(".mode").textContent(), "七猫 · 章节");
    await qimaoChapterPanel.locator(".fill").click();
    assert.equal(await qimaoChapterPage.locator("#chapter-title").inputValue(), "第1章 测试");
    assert.equal(await qimaoChapterPage.locator(".chapter-body p").count(), 2);
    assert.match(await qimaoChapterPanel.locator(".status").textContent(), /七猫章节标题和正文已填入/);
    await qimaoChapterPage.close();
  } finally {
    await browser.close();
  }
  process.stdout.write("Extension browser fixtures passed.\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
