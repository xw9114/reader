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
  --extension extension
```

```python
build(
    source_dir: Path,
    site_dir: Path,
    output_dir: Path,
    serial_dir: Path | None = None,
    extension_dir: Path | None = None,
) -> list[dict]
```

The extension requests the library through this message:

```json
{ "type": "FETCH_LIBRARY" }
```

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
      "chapters": [
        {
          "id": "chapter-1",
          "title": "第1章 名字已经签收",
          "body": "纯文本正文",
          "characters": 3011
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

The content script detects Fanqie and Qimao from the current hostname, then detects the current editor. Fanqie supports chapter, short-story, and work-information modes. Qimao supports work-information and chapter modes. Fanqie's `/book-info/` route is work-information mode and fills the book title, a reviewable synopsis draft, and up to two labeled protagonist-name inputs. In Fanqie chapter mode, a leading chapter-number prefix such as `第1章` is split between the number and title fields. Fanqie's category and publishing fields belong to the same short-story page, so their presence must never change the editor mode. Short-story mode displays the local type suggestion while keeping title/body import available. In Qimao chapter mode without a separate number field, the full chapter title is preserved and is also inserted at the start of the central editor as an `<h3>` heading. Qimao chapter body detection first selects the live `.q-contenteditable.edit-mask` inside `.chapter-con`, avoiding the sibling search, line, contrast, audit, author-note, and sidebar editors. It then falls back to semantic scoring and finally the largest central editable area. Work-information mode fills the story title and a reviewable synopsis draft derived from the first non-empty chapter body. It displays a non-binding reader direction, category, and tag suggestion, plus up to two protagonist names inferred from repeated name-like text. When labeled protagonist inputs are found, those names are filled for user review. Imported fiction body text uses two ideographic spaces at the start of prose paragraphs, keeps one blank line between paragraphs, promotes recognized chapter markers to heading nodes, and normalizes common ASCII dialogue punctuation to Chinese typography. Target reader, category, tags, status, cover, and final creation remain with the user. It must never click the final save, next, create, modify, or publish action.

## 4. Validation & Error Matrix

| Boundary | Validation | Failure behavior |
| --- | --- | --- |
| Daily source | UTF-8 Markdown; first H1 is the story title | Filename becomes the fallback title |
| Serial source | Consecutive `YYYY-MM-DD-chapter-NNNN.md` files | Build raises `ValueError` |
| Serial configuration | Exactly one `serial/books/*/book.json` | Build raises `ValueError` |
| Extension source | `extension/` exists | Bundle path is `null` when omitted |
| Remote library | HTTP success and `stories` is an array | Panel shows a read error and does not fill |
| Editor detection | Visible title and body fields both found | Panel lists missing fields and does not partially fill |
| Fanqie editor mode | `/publish-short/` is short-story; `/publish/` is chapter | URL takes priority over DOM heuristics, preventing the two editors from being reversed |
| Platform | `fanqienovel.com`, `writer.muyewx.com`, or `zuozhe.qimao.com` | Panel displays the detected platform and editor mode |
| Fanqie chapter number | Leading `第 N 章`/`Chapter N` is parsed, or the selected chapter index is used | Number is written into the separate chapter-number field |
| Fanqie title | The parsed chapter-number prefix is removed | Prevents duplicated chapter numbering |
| Fanqie short story | Story title, merged `fullText`, and an approximate type suggestion | Entire story is filled once; category selection and final submission remain manual |
| Fanqie work information | `/book-info/`; book title length follows the detected field limit (normally 15), synopsis ≤ 500 characters, an approximate type suggestion, and up to two inferred protagonist names | Overlong title is truncated with a visible warning; only labeled protagonist inputs are filled; `立即修改` remains manual |
| Qimao work information | Story title ≤ 18 characters, synopsis ≤ 500 characters, an approximate type suggestion, and up to two inferred protagonist names | Overlong title is truncated with a visible warning; protagonist names fill only labeled protagonist inputs and remain reviewable |
| Qimao chapter | Full chapter title and the large central rich-text body | Full title is preserved in the title field and inserted as the first `<h3>` in the body; side-note editors are excluded |
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
  - Assert serial chapters remain grouped and ordered.
- Browser fixture `tests/fixtures/fanqie-editor.html`
  - Assert `/publish/` is detected as chapter mode.
  - Assert the panel mounts.
  - Assert title and rich-text body are detected.
  - Assert the chapter-number field receives `1`.
  - Assert `第1章 测试` is filled as `测试`.
  - Assert the rich-text editor contains two paragraph nodes.
  - Assert paragraph breaks survive filling.
  - Assert prose indentation and Chinese dialogue punctuation normalization survive filling.
- Browser fixture `tests/fixtures/fanqie-short-story-editor.html`
  - Assert `/publish-short/` is detected as short-story mode.
  - Assert short-story mode is detected without a chapter-number field.
  - Assert chapter navigation is hidden and the action reads `填入整篇短故事`.
  - Assert the story title and all merged chapter content are filled.
  - Assert a combined rich-text editor receives one title heading followed by body paragraphs.
- Browser fixture `tests/fixtures/fanqie-work-editor.html`
  - Assert `/book-info/` is detected as Fanqie work-information mode rather than chapter mode.
  - Assert the book title, synopsis, and labeled protagonist inputs are filled.
  - Assert the extension never clicks `立即修改`.
- Browser fixtures `tests/fixtures/qimao-work-editor.html` and `qimao-chapter-editor.html`
  - Assert Qimao work-information mode displays type and protagonist suggestions, fills title, synopsis, and labeled protagonist inputs, and never clicks `确认创建`.
  - Assert Qimao chapter mode preserves the full chapter title when no number field exists.
  - Assert the full chapter title is the first `<h3>` and chapter content follows in `.chapter-con .q-contenteditable.edit-mask`, while sibling masks and the `随记` editor remain empty.
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
