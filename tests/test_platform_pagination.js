const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const queue = require(process.env.PUBLISH_QUEUE_MODULE || '../automation/publish_queue.js');
const chapter = {title:'第12章 云端存稿核验',body:'这是需要完整保存的测试正文。'};
function listHTML() {
 return '<table><tbody id="rows"><tr><td>第120章 云端存稿核验</td></tr></tbody></table>'+
 '<ul><li class="arco-pagination-item-next" onclick="document.getElementById(\'rows\').innerHTML=\'<tr><td>第12章 云端存稿核验</td><td><a href=https://fanqienovel.com/main/writer/123/publish/456/>编辑</a></td></tr>\';this.classList.add(\'arco-pagination-item-disabled\')">下一页</li></ul>';
}
(async()=>{
 const browser = await chromium.launch({headless:true});
 try {
  const page = await browser.newPage();
  await page.setContent(listHTML());
  const row = await queue.findFanqieChapterRow(page,chapter);
  assert.equal(row.editUrl,'https://fanqienovel.com/main/writer/123/publish/456/');
  assert.ok(row.text.startsWith('第12章'));
  console.log('pagination_and_chapter_identity_passed');
  await page.setContent('<table><tr><td>第120章 云端存稿核验</td></tr></table><li class="arco-pagination-item-next arco-pagination-item-disabled"></li>');
  assert.equal(await queue.findFanqieChapterRow(page,chapter),null);
  console.log('last_page_absence_passed');
  const context=await browser.newContext();
  let cloudBody=chapter.body;
  await context.route('https://fanqienovel.com/**',route=>{
   const url=route.request().url();
   const html=url.includes('chapter-manage') ? listHTML() :
    '<p>已 保存 到 云端</p><div contenteditable=true>'+cloudBody+'</div>';
   route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
  });
  const editor=await context.newPage();
  await editor.goto('https://fanqienovel.com/main/writer/123/publish/456/');
  console.log('cloud_fixture_ready',await editor.locator('body').innerText());
  assert.equal(await queue.confirmFanqieDraftSaved(editor,chapter),'draft_saved');
  cloudBody='正文被截断';
  await assert.rejects(()=>queue.confirmFanqieDraftSaved(editor,chapter),/云端草稿正文与源稿不一致/);
  await context.close();
  console.log('PLATFORM_BROWSER_FIXTURES_OK: next-page draft found; chapter 120 excluded; last page absence; full cloud roundtrip; truncated cloud draft rejected');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
