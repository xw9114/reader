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

The content script may fill detected chapter-number, title, and body fields. It extracts a leading chapter-number prefix such as `第1章`, writes `1` into Fanqie's separate chapter-number field, and writes only the remaining title into the title field. If a title has no number prefix, the selected chapter's one-based index is the fallback chapter number. Rich-text body content is inserted as paragraph nodes; blank-line paragraph boundaries must not be flattened into one text block. It must never click the final save or publish action.

## 4. Validation & Error Matrix

| Boundary | Validation | Failure behavior |
| --- | --- | --- |
| Daily source | UTF-8 Markdown; first H1 is the story title | Filename becomes the fallback title |
| Serial source | Consecutive `YYYY-MM-DD-chapter-NNNN.md` files | Build raises `ValueError` |
| Serial configuration | Exactly one `serial/books/*/book.json` | Build raises `ValueError` |
| Extension source | `extension/` exists | Bundle path is `null` when omitted |
| Remote library | HTTP success and `stories` is an array | Panel shows a read error and does not fill |
| Editor detection | Visible title and body fields both found | Panel lists missing fields and does not partially fill |
| Fanqie chapter number | Leading `第 N 章`/`Chapter N` is parsed, or the selected chapter index is used | Number is written into the separate chapter-number field |
| Fanqie title | The parsed chapter-number prefix is removed | Prevents duplicated chapter numbering |
| Rich-text body | Blank lines become separate paragraph nodes; single line breaks become `<br>` | Prevents the whole chapter becoming one paragraph |

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
  - Assert the panel mounts.
  - Assert title and rich-text body are detected.
  - Assert the chapter-number field receives `1`.
  - Assert `第1章 测试` is filled as `测试`.
  - Assert the rich-text editor contains two paragraph nodes.
  - Assert paragraph breaks survive filling.

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
