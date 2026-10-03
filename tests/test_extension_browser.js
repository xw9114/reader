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
    assert.equal(await chapterPanel.locator(".mode").textContent(), "番茄 · 章节");
    await chapterPanel.locator(".fill").click();
    assert.equal(await chapterPage.locator("#chapter-number").inputValue(), "1");
    assert.equal(await chapterPage.locator("#chapter-title").inputValue(), "测试");
    assert.equal(await chapterPage.locator(".chapter-editor p").count(), 2);
    assert.equal(
      await chapterPage.evaluate(() => window.__readerPublisherImporter.formatBodyText('"你好,小雨?"\n\n他说.')),
      "　　“你好，小雨？”\n\n　　他说。",
    );
    await chapterPage.close();

    const shortStoryPage = await openFixture(browser, "fanqie-short-story-editor.html");
    const shortStoryPanel = shortStoryPage.locator("#reader-fanqie-importer");
    assert.equal(await shortStoryPanel.locator(".mode").textContent(), "番茄 · 短故事");
    assert.equal(await shortStoryPanel.locator(".fill").textContent(), "填入整篇短故事");
    assert.equal(await shortStoryPanel.locator(".chapter-row").isVisible(), false);
    assert.equal(await shortStoryPanel.locator(".type-suggestion").isVisible(), true);
    await shortStoryPanel.locator(".fill").click();
    assert.equal(await shortStoryPage.locator(".short-story-title").textContent(), "测试短故事");
    assert.equal(await shortStoryPage.locator(".short-story-body h2").count(), 2);
    assert.equal(await shortStoryPage.locator(".short-story-body p").count(), 2);
    assert.equal(await shortStoryPage.locator(".short-story-body p").first().textContent(), "　　第一段。");
    assert.match(await shortStoryPage.locator(".short-story-body").innerText(), /开篇钩子[\s\S]*第1章 相遇/);
    assert.match(await shortStoryPanel.locator(".status").textContent(), /整篇正文已填入/);
    await shortStoryPage.close();

    const combinedPage = await openFixture(browser, "fanqie-short-story-combined-editor.html");
    const combinedPanel = combinedPage.locator("#reader-fanqie-importer");
    assert.equal(await combinedPanel.locator(".mode").textContent(), "番茄 · 短故事");
    await combinedPanel.locator(".fill").click();
    assert.equal(await combinedPage.locator(".short-story-editor h1").textContent(), "合并编辑器故事");
    assert.equal(await combinedPage.locator(".short-story-editor h2").textContent(), "开篇");
    assert.equal(await combinedPage.locator(".short-story-editor p").count(), 2);
    await combinedPage.close();

    const qimaoWorkPage = await openFixture(browser, "qimao-work-editor.html");
    const qimaoWorkPanel = qimaoWorkPage.locator("#reader-fanqie-importer");
    assert.equal(await qimaoWorkPanel.locator(".mode").textContent(), "七猫 · 作品信息");
    assert.equal(await qimaoWorkPanel.locator(".fill").textContent(), "填入作品信息");
    assert.equal(await qimaoWorkPanel.locator(".chapter-row").isVisible(), false);
    assert.equal(await qimaoWorkPanel.locator(".type-suggestion").isVisible(), true);
    assert.equal(
      await qimaoWorkPanel.locator(".suggestion").textContent(),
      "方向待定｜都市 > 都市生活｜标签：都市生活",
    );
    assert.equal(await qimaoWorkPanel.locator(".protagonist-suggestion").isVisible(), true);
    assert.equal(await qimaoWorkPanel.locator(".protagonists").textContent(), "周晓雨、陈浩");
    const suggestedType = await qimaoWorkPage.evaluate(() => (
      window.__readerPublisherImporter.suggestWorkType({
        title: "我的渣男前夫成了我的下属",
        chapters: [{
          title: "第1章 重逢",
          body: "三年后，她在公司酒会上重逢前夫。曾经的集团总监，如今成了她的下属。",
        }],
      }).text
    ));
    assert.equal(
      suggestedType,
      "女频｜现代言情 > 职场婚恋｜标签：婚恋纠葛、职场、复仇逆袭、久别重逢",
    );
    await qimaoWorkPanel.locator(".fill").click();
    assert.equal(await qimaoWorkPage.locator("#work-title").inputValue(), "测试七猫作品");
    assert.match(await qimaoWorkPage.locator("#work-summary").inputValue(), /^这是用于七猫作品简介/);
    assert.ok((await qimaoWorkPage.locator("#work-summary").inputValue()).length <= 500);
    assert.deepEqual(
      await qimaoWorkPage.locator(".protagonist-name").evaluateAll((elements) => elements.map((element) => element.value)),
      ["周晓雨", "陈浩", ""],
    );
    assert.equal(await qimaoWorkPage.evaluate(() => window.__QIMAO_CONFIRM_CLICKS__), 0);
    assert.match(await qimaoWorkPanel.locator(".status").textContent(), /作品名称和简介草稿已填入/);
    await qimaoWorkPage.close();

    const fanqieWorkPage = await openFixture(browser, "fanqie-work-editor.html");
    const fanqieWorkPanel = fanqieWorkPage.locator("#reader-fanqie-importer");
    assert.equal(await fanqieWorkPanel.locator(".mode").textContent(), "番茄 · 作品信息");
    assert.equal(await fanqieWorkPanel.locator(".fill").textContent(), "填入作品信息");
    assert.equal(await fanqieWorkPanel.locator(".chapter-row").isVisible(), false);
    assert.equal(await fanqieWorkPanel.locator(".type-suggestion").isVisible(), true);
    assert.equal(await fanqieWorkPanel.locator(".protagonist-suggestion").isVisible(), true);
    assert.equal(await fanqieWorkPanel.locator(".protagonists").textContent(), "周晓雨、陈浩");
    await fanqieWorkPanel.locator(".fill").click();
    assert.equal(await fanqieWorkPage.locator("#book-title").inputValue(), "我的渣男前夫成了我的下属");
    assert.match(await fanqieWorkPage.locator("#work-summary").inputValue(), /^周晓雨没想到/);
    assert.ok((await fanqieWorkPage.locator("#work-summary").inputValue()).length <= 500);
    assert.deepEqual(
      await fanqieWorkPage.locator(".protagonist-name").evaluateAll((elements) => elements.map((element) => element.value)),
      ["周晓雨", "陈浩"],
    );
    assert.equal(await fanqieWorkPage.evaluate(() => window.__FANQIE_UPDATE_CLICKS__), 0);
    assert.match(await fanqieWorkPanel.locator(".status").textContent(), /作品名称和简介草稿已填入/);
    await fanqieWorkPage.close();

    const qimaoChapterPage = await openFixture(browser, "qimao-chapter-editor.html");
    const qimaoChapterPanel = qimaoChapterPage.locator("#reader-fanqie-importer");
    assert.equal(await qimaoChapterPanel.locator(".mode").textContent(), "七猫 · 章节");
    assert.equal(await qimaoChapterPanel.locator(".type-suggestion").isVisible(), false);
    await qimaoChapterPanel.locator(".fill").click();
    assert.equal(await qimaoChapterPage.locator("#chapter-title").inputValue(), "第1章 测试");
    assert.equal(await qimaoChapterPage.locator(".chapter-con .edit-mask h3").count(), 1);
    assert.equal(await qimaoChapterPage.locator(".chapter-con .edit-mask h3").textContent(), "第1章 测试");
    assert.equal(await qimaoChapterPage.locator(".chapter-con .edit-mask p").count(), 2);
    assert.equal(await qimaoChapterPage.locator(".chapter-con .edit-mask p").first().textContent(), "　　第一段。");
    assert.equal(await qimaoChapterPage.locator(".chapter-con .search-mask").textContent(), "");
    assert.equal(await qimaoChapterPage.locator(".note-editor").textContent(), "");
    assert.match(await qimaoChapterPanel.locator(".status").textContent(), /七猫章节标题已作为正文标题写入/);
    await qimaoChapterPage.close();

    const qimaoShortStoryPage = await openFixture(browser, "qimao-short-story-editor.html");
    const qimaoShortStoryPanel = qimaoShortStoryPage.locator("#reader-fanqie-importer");
    assert.equal(await qimaoShortStoryPanel.locator(".mode").textContent(), "七猫 · 短故事");
    assert.equal(await qimaoShortStoryPanel.locator(".fill").textContent(), "填入整篇短故事");
    assert.equal(await qimaoShortStoryPanel.locator(".chapter-row").isVisible(), false);
    await qimaoShortStoryPanel.locator(".fill").click();
    assert.deepEqual(
      await qimaoShortStoryPage.locator(".chapter-con .edit-mask h3").allTextContents(),
      ["第1章 相遇", "第2章 选择"],
    );
    assert.equal(await qimaoShortStoryPage.locator(".chapter-con .edit-mask p").count(), 3);
    assert.equal(await qimaoShortStoryPage.locator(".note-editor").textContent(), "");
    assert.match(await qimaoShortStoryPanel.locator(".status").textContent(), /整篇短故事已一次填入，共 2 章/);
    await qimaoShortStoryPage.close();
  } finally {
    await browser.close();
  }
  process.stdout.write("Extension browser fixtures passed.\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
