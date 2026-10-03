# Publishing Import Contract

## 1. Scope / Trigger

This contract applies when `daily/`, `serial/published/`, the publishing page, or the browser extension changes. The build output is consumed by both the static site and `extension/background.js`.

## 2. Signatures

```text
python tools/build_publish.py \
  --source daily \
  --serial serial \
  --site site \
  --output dist \
  --extension extension \
  --covers covers
```

```python
build(
    source_dir: Path,
    site_dir: Path,
    output_dir: Path,
    serial_dir: Path | None = None,
    extension_dir: Path | None = None,
    cover_dir: Path | None = None,
) -> list[dict]
```

The extension requests the library through this message:

```json
{ "type": "FETCH_LIBRARY" }
```

It requests a same-origin Reader cover through `{ "type": "FETCH_COVER", "coverUrl": "covers/serial-main.svg" }`. The background returns a checked `data:image/*` URL and refuses cross-origin cover proxying.

The offline cover generator calls the authenticated OpenAI-compatible endpoint `POST https://api.xw9114.online/v1/images/generations`. It defaults to `gpt-image-2`, `1024x1536`, and PNG output. The Gateway Token is accepted only through `READER_IMAGE_API_KEY` and is never emitted into `dist/` or the extension bundle.

## 3. Contracts

`dist/data.json` contains:

```json
{
  "latestStoryId": "serial-main",
  "storyCount": 16,
  "extensionDownload": "downloads/fanqie-publisher-extension.zip",
  "stories": [
    {
      "id": "serial-main",
      "title": "旧城清算",
      "date": "2026-09-23",
      "source": "serial/published/",
      "download": "downloads/serial-book.txt",
      "downloads": {
        "txt": "downloads/serial-book.txt",
        "md": "downloads/serial-book.md",
        "zip": "downloads/serial-book.zip"
      },
      "characters": 12000,
      "cover": {
        "url": "covers/serial-main.svg",
        "mimeType": "image/svg+xml",
        "source": "generated-default",
        "width": 768,
        "height": 1024
      },
      "volumes": [
        {"number": 1, "title": "名字被谁写走", "startChapter": 1, "endChapter": 25}
      ],
      "publishingHint": {
        "schemaVersion": 1,
        "source": "inkos",
        "audience": "女频",
        "readingTags": ["都市悬疑"],
        "contentTags": ["调查取证", "现实题材"],
        "tagDimensions": {
          "plot": ["推理", "调查取证"],
          "emotion": ["亲情"],
          "persona": ["女强", "理性清醒"],
          "worldview": []
        }
      },
      "chapters": [
        {
          "id": "chapter-1",
          "title": "第1章 名字已经签收",
          "body": "纯文本正文",
          "interaction": "本章围绕“名字已经签收”推进了关键线索。你觉得哪个细节最值得追查？欢迎留言聊聊。",
          "characters": 3011,
          "volume": {"number": 1, "title": "名字被谁写走"}
        }
      ],
      "fullText": "第1章 名字已经签收\n\n纯文本正文"
    }
  ]
}
```

The background response is either:

```json
{ "ok": true, "payload": {}, "dataUrl": "https://xw9114.github.io/reader/data.json" }
```

or:

```json
{ "ok": false, "error": "HTTP 404" }
```

The content script detects Fanqie and Qimao from the current hostname, then detects the current editor. Fanqie supports chapter, short-story, work-information, and volume-management modes. Qimao supports work-information, chapter, and whole-story short-story modes. Fanqie's `/book-info/` route is work-information mode and fills the book title, a reviewable synopsis draft, and up to two labeled protagonist-name inputs. Fanqie's `/chapter-manage/` route with chapter-management and volume controls is volume-management mode. It displays InkOS volumes, chapter ranges, and the number of locally published chapters in the selected volume. After the user opens the platform's edit/new-volume form, the extension fills only the selected volume name and leaves save confirmation to the user. In Fanqie chapter mode, a leading chapter-number prefix such as `第1章` is split between the number and title fields. Fanqie's category and publishing fields belong to the same short-story page, so their presence must never change the editor mode. Short-story mode displays the local type suggestion while keeping title/body import available. Qimao short-story mode is detected from its persistent editor instructions and imports all local chapters in one action, rendering every chapter title as an `<h3>` followed by its formatted body. Qimao chapter mode writes the full chapter title only into the separate title field and writes prose only into the central editor, preventing a duplicated heading at the start of the body. Qimao chapter body detection first selects the live `.q-contenteditable.edit-mask` inside `.chapter-con`, avoiding the sibling search, line, contrast, audit, author-note, and sidebar editors. It then falls back to semantic scoring and finally the largest central editable area. Every chapter includes a deterministic `interaction` of at most 60 characters. It summarizes the chapter topic, asks one reader-facing question, and is shown only in chapter mode. The user first opens the platform's “作者有话说/有话说/章末寄语” area, then clicks the extension's separate “填入章末互动” button. Author-note detection excludes the title, body, search, and Qimao sidebar memo controls. Work-information mode fills the story title and a reviewable synopsis draft derived from the first non-empty chapter body. It displays the InkOS publishing classification from `book.json`, plus up to two protagonist names inferred from repeated name-like text. Only legacy stories without `publishingHint` use title/body classification, and the panel identifies which source was used. Protagonist detection supports text inputs, textareas, `role=textbox`, and contenteditable fields. It selects controls on the visual row between “主角名” and “添加角色”, excludes rows whose surrounding text identifies type/category/tag controls, and fills editable containers as plain text. Imported fiction body text uses two ideographic spaces at the start of prose paragraphs, keeps one blank line between paragraphs, promotes recognized chapter markers to heading nodes, and normalizes common ASCII dialogue punctuation to Chinese typography. Work-information and short-story modes display the story's dedicated cover and can place it into a detected image file input. SVG defaults are converted to PNG in-browser before assignment. The extension dispatches input/change events but never clicks the platform's save, next, create, modify, or publish action.

## 4. Validation & Error Matrix

| Boundary | Validation | Failure behavior |
| --- | --- | --- |
| Daily source | UTF-8 Markdown; first H1 is the story title | Filename becomes the fallback title |
| Serial source | Consecutive `YYYY-MM-DD-chapter-NNNN.md` files | Build raises `ValueError` |
| Serial configuration | Exactly one `serial/books/*/book.json` | Build raises `ValueError` |
| Serial publishing metadata | Schema version 1; source `inkos`; 1–2 reading tags; 1–4 content tags; plot ≤ 4, emotion ≤ 2, persona ≤ 4, worldview ≤ 1 | Build raises `ValueError`; the extension never silently reclassifies the serial from prose |
| Serial volume plan | 1–12 volumes; consecutive numbers; chapter ranges continuously cover chapter 1 through `targetChapters`; names contain 1–30 characters | Build raises `ValueError`; chapters are never assigned to an ambiguous or missing volume |
| Extension source | `extension/` exists | Bundle path is `null` when omitted |
| Story cover | Matching `covers/<story-id>.(png|jpg|jpeg|webp|svg)` | A deterministic 768×1024 SVG is generated for that story |
| Cover fetch | Same origin as configured Reader `data.json`; image MIME; ≤ 12 MiB | Request is rejected and no file input is changed |
| Cover upload | Image file input associated with cover controls | The image is assigned and events dispatched; platform save remains manual |
| Cover generation API | Authenticated OpenAI-compatible `data[0].b64_json` or HTTPS `data[0].url`; PNG/JPEG/WebP; ≤ 12 MiB | Generation stops with an explicit error; no existing cover is overwritten |
| Remote library | HTTP success and `stories` is an array | Panel shows a read error and does not fill |
| Editor detection | Visible title and body fields both found | Panel lists missing fields and does not partially fill |
| Fanqie editor mode | `/publish-short/` is short-story; `/publish/` is chapter | URL takes priority over DOM heuristics, preventing the two editors from being reversed |
| Platform | `fanqienovel.com`, `writer.muyewx.com`, or `zuozhe.qimao.com` | Panel displays the detected platform and editor mode |
| Fanqie chapter number | Leading `第 N 章`/`Chapter N` is parsed, or the selected chapter index is used | Number is written into the separate chapter-number field |
| Fanqie title | The parsed chapter-number prefix is removed | Prevents duplicated chapter numbering |
| Fanqie short story | Story title, merged `fullText`, and an approximate type suggestion | Entire story is filled once; category selection and final submission remain manual |
| Fanqie work information | `/book-info/`; book title length follows the detected field limit (normally 15), synopsis ≤ 500 characters, an approximate type suggestion, and up to two inferred protagonist names | Overlong title is truncated with a visible warning; only labeled protagonist inputs are filled; `立即修改` remains manual |
| Qimao work information | Story title ≤ 18 characters, synopsis ≤ 500 characters, an approximate type suggestion, and up to two inferred protagonist names | Overlong title is truncated with a visible warning; protagonist names fill only labeled protagonist inputs and remain reviewable |
| Qimao protagonist controls | Text input, textarea, `role=textbox`, or contenteditable on the “主角名/添加角色” row; surrounding type/category/tag rows are excluded | Names are never written into work-type fields; unmatched controls stay unchanged |
| Qimao short story | Editor instructions identify the 4000–70000 word whole-story form; all chapters are converted to `<h3>` headings plus formatted paragraphs | The chapter selector is hidden and one action fills the entire work; an out-of-range word count is shown as a warning |
| Qimao chapter | Full chapter title and the large central rich-text body | Full title is preserved in the title field and omitted from the body; side-note editors are excluded |
| Chapter interaction | `interaction` ≤ 60 characters; chapter mode only; input context includes author-note wording and excludes memo/body/search controls | The extension asks the user to open the platform author-note area and never falls back to the body or Qimao “随记” |
| Rich-text body | Blank lines become separate nodes; prose paragraphs receive a two-character indent; recognized chapter markers become `<h2>`; single line breaks become `<br>` | Prevents wall-of-text imports while preserving the story structure |

## 5. Good / Base / Bad Cases

- Good: a serial book plus daily stories produces one serial entry, daily entries, three formats per story, and the extension ZIP.
- Base: a single daily Markdown file without H2 headings is exported as one chapter.
- Bad: a serial sequence containing chapter `0001` and `0003` fails instead of silently publishing an incomplete book.

## 6. Tests Required

- `python -m unittest discover -s tests -v`
  - Assert Markdown formatting is removed from extension body text.
  - Assert daily TXT starts with a UTF-8 BOM.
  - Assert story ZIP contains per-chapter TXT files.
  - Assert extension ZIP contains `manifest.json`.
  - Assert every story has a cover artifact and custom matching covers override the generated default.
  - Assert the cover generator uses the configured `/images/generations` endpoint and decodes an official `b64_json` response.
  - Assert serial chapters remain grouped and ordered.
  - Assert every built chapter has a short reader interaction ending in a question and comment invitation.
- Browser fixture `tests/fixtures/fanqie-editor.html`
  - Assert `/publish/` is detected as chapter mode.
  - Assert the panel mounts.
  - Assert title and rich-text body are detected.
  - Assert the chapter-number field receives `1`.
  - Assert `第1章 测试` is filled as `测试`.
  - Assert the rich-text editor contains two paragraph nodes.
  - Assert paragraph breaks survive filling.
  - Assert the chapter interaction preview is visible and fills only the author-note field without clicking publish.
  - Assert prose indentation and Chinese dialogue punctuation normalization survive filling.
- Browser fixture `tests/fixtures/fanqie-short-story-editor.html`
  - Assert `/publish-short/` is detected as short-story mode.
  - Assert short-story mode is detected without a chapter-number field.
  - Assert chapter navigation is hidden and the action reads `填入整篇短故事`.
  - Assert the story title and all merged chapter content are filled.
  - Assert a combined rich-text editor receives one title heading followed by body paragraphs.
  - Assert the current story cover is placed into the cover file input without clicking any save or publish control.
- Browser fixture `tests/fixtures/fanqie-work-editor.html`
  - Assert `/book-info/` is detected as Fanqie work-information mode rather than chapter mode.
  - Assert the book title, synopsis, and labeled protagonist inputs are filled.
  - Assert the extension never clicks `立即修改`.
- Browser fixture `tests/fixtures/fanqie-volume-manager.html`
  - Assert `/chapter-manage/` is detected as volume-management mode instead of chapter mode.
  - Assert all structured InkOS volumes and ranges are displayed.
  - Assert the selected volume name is filled only after the platform form is open.
  - Assert the extension never clicks the platform's save-volume action.
- Browser fixtures `tests/fixtures/qimao-work-editor.html`, `qimao-chapter-editor.html`, and `qimao-short-story-editor.html`
  - Assert Qimao work-information mode displays type and protagonist suggestions, fills title, synopsis, and labeled protagonist inputs, and never clicks `确认创建`.
  - Assert contenteditable protagonist controls are filled left-to-right and work-type inputs retain their original values.
  - Assert Qimao chapter mode preserves the full chapter title when no number field exists.
  - Assert the full chapter title is present only in the title field; `.chapter-con .q-contenteditable.edit-mask` contains prose paragraphs without a duplicate `<h3>`, while sibling masks and the `随记` editor remain empty.
  - Assert “填入章末互动” fills the Qimao “有话说” field while the `随记` editor remains empty and save is never clicked.
  - Assert Qimao's whole-story instructions select short-story mode, hide chapter navigation, and import every chapter with one `<h3>` per chapter.
  - Assert body paragraph structure survives filling.

## 7. Wrong vs Correct

### Wrong

```javascript
document.querySelector("input").value = chapter.title;
document.execCommand("insertText", false, chapter.body);
document.querySelector("button.publish").click();
```

This selects arbitrary fields, duplicates the chapter number, flattens rich-text paragraphs, does not notify reactive editors, and publishes without review.

### Correct

```javascript
const result = fillEditor(chapter.title, chapter.body);
if (result.ok) {
  updateStatus("标题和正文已填入，请核对后在番茄后台保存或发布。", "success");
}
```

Field scoring, input events, and a manual final publish step are required.
