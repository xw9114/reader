(() => {
  const ROOT_ID = "reader-fanqie-importer";
  const STORAGE_DEFAULTS = { storyId: "", chapterIndex: 0, volumeIndex: 0, collapsed: false };
  const state = {
    stories: [],
    activeStory: null,
    activeChapterIndex: 0,
    activeVolumeIndex: 0,
    fields: {
      platform: "fanqie",
      mode: "chapter",
      chapterNumber: null,
      title: null,
      summary: null,
      protagonists: [],
      volumeName: null,
      body: null,
      combinedEditor: false,
    },
  };

  function currentPlatform() {
    if (globalThis.__READER_TEST_PLATFORM__) return globalThis.__READER_TEST_PLATFORM__;
    return location.hostname.endsWith("qimao.com") ? "qimao" : "fanqie";
  }

  function currentPathname() {
    return globalThis.__READER_TEST_PATHNAME__ || location.pathname;
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
  }

  function fieldText(element) {
    const attributes = ["placeholder", "aria-label", "name", "id", "class", "data-placeholder"];
    const own = attributes.map((name) => element.getAttribute(name) || "").join(" ");
    const parent = element.closest("label, [class*='form'], [class*='field'], [class*='editor']");
    return `${own} ${parent?.textContent?.slice(0, 160) || ""}`.toLowerCase();
  }

  function titleScore(element) {
    const text = fieldText(element);
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (/章节标题|章节名|标题|chapter.?title/.test(text)) score += 12;
    if (/请输入.*标题|title/.test(text)) score += 5;
    if (/章节序号|章节号|章序|chapter.?number/.test(text)) score -= 18;
    if (/搜索|search|简介|书名|短故事名称|故事名称/.test(text)) score -= 14;
    if (element instanceof HTMLInputElement) score += 3;
    if (element.isContentEditable) score += 3;
    if (element instanceof HTMLInputElement && element.type === "number") score -= 18;
    if (rect.width <= 160) score -= 8;
    if (element.maxLength > 0 && element.maxLength <= 100) score += 3;
    return score;
  }

  function shortStoryTitleScore(element) {
    const text = fieldText(element);
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (/短故事名称|故事名称|请输入短故事名称|short.?story.?title/.test(text)) score += 24;
    if (/作品名称|请输入.*名称/.test(text)) score += 7;
    if (/章节标题|章节名|章节序号|章序/.test(text)) score -= 20;
    if (/搜索|search|简介|正文|内容/.test(text)) score -= 12;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable) {
      score += 4;
    }
    if (rect.height <= 120) score += 4;
    if (rect.height >= 180) score -= 6;
    if (rect.width >= 260) score += 2;
    return score;
  }

  function shortStoryFallbackScore(element) {
    const text = fieldText(element);
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (element.isContentEditable) score += 8;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) score += 4;
    if (rect.width >= 400) score += 4;
    if (rect.height <= 120) score += 6;
    else if (rect.height >= 180) score += 2;
    if (/搜索|评论|简介|章节序号|章序/.test(text)) score -= 14;
    return score;
  }

  function workTitleScore(element) {
    const text = fieldText(element);
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (/作品名称|书本名称|书名|请输入作品名称|book.?title/.test(text)) score += 22;
    if (/最多\s*18\s*个字/.test(text)) score += 8;
    if (/章节|简介|搜索|角色/.test(text)) score -= 16;
    if (element instanceof HTMLInputElement) score += 5;
    if (rect.height <= 80 && rect.width >= 260) score += 4;
    return score;
  }

  function summaryScore(element) {
    const text = fieldText(element);
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (/作品简介|内容简介|故事简介|请输入.*简介|最多\s*500\s*字|synopsis|summary/.test(text)) score += 22;
    if (/章节|标题|搜索|角色/.test(text)) score -= 14;
    if (element instanceof HTMLTextAreaElement || element.isContentEditable) score += 5;
    if (rect.height >= 100 && rect.width >= 320) score += 4;
    return score;
  }

  function volumeNameScore(element) {
    const text = fieldText(element);
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (/分卷名称|卷名称|卷名|请输入.*分卷/.test(text)) score += 24;
    if (/搜索|search|章节|作品名称|书名/.test(text)) score -= 18;
    if (element instanceof HTMLInputElement) score += 5;
    if (rect.height <= 80 && rect.width >= 180) score += 3;
    return score;
  }

  function coverInputScore(element) {
    const text = fieldText(element);
    let score = 0;
    if (!(element instanceof HTMLInputElement) || element.type !== "file" || element.disabled) return -100;
    if (/image/.test(element.accept || "")) score += 12;
    if (/封面|cover|上传图片|选择图片|图片上传/.test(text)) score += 20;
    if (/正文插图|头像|证件|附件/.test(text)) score -= 20;
    return score;
  }

  function findCoverInput() {
    return [...document.querySelectorAll("input[type='file']")]
      .map((element) => ({ element, score: coverInputScore(element) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.element || null;
  }

  function protagonistOwnText(element) {
    return ["placeholder", "aria-label", "name", "id", "class", "data-placeholder"]
      .map((name) => element.getAttribute(name) || "")
      .join(" ")
      .toLowerCase();
  }

  function isSafeProtagonistField(element, excludedTitle = null) {
    if (element === excludedTitle || !isVisible(element) || element.disabled || element.readOnly) return false;
    if (element.getAttribute("role") === "combobox" || element.getAttribute("aria-haspopup") === "listbox") return false;
    if (element.closest("select, [role='combobox'], [class*='select'], [class*='dropdown'], [class*='cascader']")) return false;
    if (/作品类型|作品标签|阅读标签|内容标签|目标读者|一级分类|二级分类/.test(protagonistOwnText(element))) return false;
    return true;
  }

  function findProtagonistFields(excludedTitle = null) {
    const inputSelector = "input:not([type]), input[type='text']";
    const found = [...document.querySelectorAll(inputSelector)]
      .filter((element) => isSafeProtagonistField(element, excludedTitle))
      .filter((element) => /主角名|主角姓名|角色名|人物名/.test(protagonistOwnText(element)));
    const labels = [...document.querySelectorAll("label, span, p, div, [class*='label']")]
      .filter((element) => isVisible(element) && /^主角名(?:称)?$/.test(String(element.textContent || "").trim()))
      .sort((left, right) => left.childElementCount - right.childElementCount);
    for (const label of labels) {
      const labelRect = label.getBoundingClientRect();
      const labelCenter = labelRect.top + labelRect.height / 2;
      let container = label;
      for (let depth = 0; depth < 5 && container; depth += 1, container = container.parentElement) {
        const inputs = [...container.querySelectorAll(inputSelector)]
          .filter((element) => isSafeProtagonistField(element, excludedTitle))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const center = rect.top + rect.height / 2;
            return Math.abs(center - labelCenter) <= Math.max(48, labelRect.height * 2.5)
              && rect.left >= labelRect.left;
          });
        inputs.forEach((element) => {
          if (!found.includes(element)) found.push(element);
        });
        if (inputs.length) break;
      }
    }
    return found.slice(0, 3);
  }

  function chapterNumberScore(element) {
    const text = fieldText(element);
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (/章节序号|章节号|章序|chapter.?number|chapter.?index/.test(text)) score += 18;
    if (/第\s*[^章]{0,12}\s*章/.test(text)) score += 12;
    if (element instanceof HTMLInputElement && element.type === "number") score += 10;
    if (element instanceof HTMLInputElement && element.inputMode === "numeric") score += 8;
    if (element.maxLength > 0 && element.maxLength <= 8) score += 6;
    if (rect.width <= 160 && rect.height <= 80) score += 9;
    if (rect.width > 260 || rect.height > 100) score -= 16;
    if (/搜索|search|正文|内容|书名/.test(text)) score -= 14;
    return score;
  }

  function bodyScore(element) {
    const text = fieldText(element);
    const rect = element.getBoundingClientRect();
    const ownText = ["placeholder", "aria-label", "name", "id", "class", "data-placeholder"]
      .map((name) => element.getAttribute(name) || "")
      .join(" ")
      .toLowerCase();
    const sideRegion = element.closest("aside, [class*='sidebar'], [class*='side-bar'], [class*='note'], [class*='memo']");
    const sideText = `${sideRegion?.getAttribute("class") || ""} ${sideRegion?.textContent?.slice(0, 240) || ""}`.toLowerCase();
    let score = 0;
    if (/正文|章节内容|内容|请输入正文|content|editor/.test(text)) score += 10;
    if (/简介|搜索|标题|书名|短故事名称|故事名称/.test(text)) score -= 12;
    if (/随记|笔记|资料|灵感|润色|起名|note|memo|sidebar|side-bar/.test(`${ownText} ${sideText}`)) score -= 32;
    if (element.isContentEditable) score += 6;
    if (rect.height >= 180) score += 5;
    if (rect.width >= 500) score += 3;
    if (rect.width >= 700) score += 5;
    if (rect.width < 420) score -= 10;
    if (rect.left >= window.innerWidth * 0.72) score -= 18;
    return score;
  }

  function bestCandidate(selector, scorer, excluded = null) {
    return [...document.querySelectorAll(selector)]
      .filter((element) => element !== excluded && isVisible(element))
      .map((element) => ({ element, score: scorer(element) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.element || null;
  }

  function largestCentralEditor(selector, excluded = null) {
    return [...document.querySelectorAll(selector)]
      .filter((element) => element !== excluded && isVisible(element))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width >= 600 && rect.height >= 160 && rect.left < window.innerWidth * 0.72)
      .sort((left, right) => right.rect.width * right.rect.height - left.rect.width * left.rect.height)[0]?.element || null;
  }

  function qimaoChapterBody() {
    const selectors = [
      ".chapter-con .q-contenteditable.edit-mask[contenteditable]:not([contenteditable='false'])",
      ".chapter-con .q-contenteditable[contenteditable]:not([contenteditable='false'])",
      ".chapter-editor .q-contenteditable.edit-mask[contenteditable]:not([contenteditable='false'])",
      ".chapter-editor .q-contenteditable[contenteditable]:not([contenteditable='false'])",
    ];
    for (const selector of selectors) {
      const candidates = [...document.querySelectorAll(selector)]
        .filter((element) => element instanceof HTMLElement && element.isConnected);
      const visible = candidates.find(isVisible);
      if (visible) return visible;
      if (candidates.length === 1) return candidates[0];
    }
    return null;
  }

  function detectEditorFields() {
    const platform = currentPlatform();
    const pathname = currentPathname();
    const pageText = document.body?.innerText || "";
    const pageSourceText = document.body?.textContent || pageText;
    const pageLooksLikeQimaoWorkInfo = platform === "qimao"
      && /作品信息/.test(pageText)
      && /作品名称/.test(pageText)
      && /作品简介/.test(pageText);
    const pageLooksLikeFanqieWorkInfo = platform === "fanqie"
      && /\/book-info(?:\/|$)/.test(pathname)
      && /(?:修改)?作品信息/.test(pageText)
      && /书本名称|作品名称/.test(pageText)
      && /作品简介/.test(pageText);
    const pageLooksLikeWorkInfo = pageLooksLikeQimaoWorkInfo || pageLooksLikeFanqieWorkInfo;
    if (pageLooksLikeWorkInfo) {
      const title = bestCandidate(
        "input:not([type]), input[type='text'], textarea, [contenteditable='true'], [role='textbox']",
        workTitleScore,
      );
      const summary = bestCandidate(
        "textarea, [contenteditable='true'], [role='textbox']",
        summaryScore,
        title,
      );
      const protagonists = findProtagonistFields(title);
      state.fields = {
        platform,
        mode: "work-info",
        chapterNumber: null,
        title,
        summary,
        protagonists,
        volumeName: null,
        body: null,
        combinedEditor: false,
      };
      return state.fields;
    }
    const pageLooksLikeFanqieVolumeManager = platform === "fanqie"
      && /\/chapter-manage(?:\/|$)/.test(pathname)
      && /章节管理/.test(pageText)
      && /编辑分卷/.test(pageText);
    if (pageLooksLikeFanqieVolumeManager) {
      const volumeName = bestCandidate(
        "input:not([type]), input[type='text'], textarea, [contenteditable='true'], [role='textbox']",
        volumeNameScore,
      );
      state.fields = {
        platform,
        mode: "volume-manage",
        chapterNumber: null,
        title: null,
        summary: null,
        protagonists: [],
        volumeName,
        body: null,
        combinedEditor: false,
      };
      return state.fields;
    }
    const fanqieShortPath = platform === "fanqie" && /\/publish-short(?:\/|$)/.test(pathname);
    const fanqieChapterPath = platform === "fanqie" && /\/publish(?:\/|$)/.test(pathname);
    const pageLooksLikeFanqieShortStory = platform === "fanqie"
      && /未命名短故事|请输入短故事名称/.test(pageText);
    const pageLooksLikeQimaoShortStory = platform === "qimao"
      && (
        /将[“"]?正文[”"]?切换为[“"]?标题/.test(pageSourceText)
        || /正文字数最少\s*4000\s*字[^\n]{0,40}最多\s*70000\s*字/.test(pageSourceText)
      );
    const mode = fanqieShortPath || pageLooksLikeQimaoShortStory
      ? "short-story"
      : fanqieChapterPath
        ? "chapter"
        : pageLooksLikeFanqieShortStory
          ? "short-story"
          : "chapter";
    const chapterNumber = bestCandidate(
      "input:not([type]), input[type='text'], input[type='number'], [contenteditable='true']",
      chapterNumberScore,
    );
    const shortStorySelector = "input:not([type]), input[type='text'], textarea, [contenteditable='true'], [role='textbox']";
    const shortStoryTitle = mode === "short-story" && platform === "fanqie"
      ? bestCandidate(shortStorySelector, shortStoryTitleScore, chapterNumber)
        || bestCandidate(shortStorySelector, shortStoryFallbackScore, chapterNumber)
      : null;
    const chapterTitle = bestCandidate(
      "input:not([type]), input[type='text'], textarea, [contenteditable='true'], [role='textbox']",
      titleScore,
      chapterNumber,
    );
    const title = mode === "short-story"
      ? platform === "qimao" ? null : shortStoryTitle || chapterTitle
      : chapterTitle;
    const bodySelector = "[contenteditable]:not([contenteditable='false']), textarea, [role='textbox']";
    let body = platform === "qimao" ? qimaoChapterBody() : null;
    if (!body) {
      body = bestCandidate(
        bodySelector,
        bodyScore,
        title,
      );
    }
    if (!body && platform === "qimao") body = largestCentralEditor(bodySelector, title);
    const combinedEditor = Boolean(
      mode === "short-story"
      && title
      && !body
      && title.isContentEditable
      && title.getBoundingClientRect().height >= 160,
    );
    if (combinedEditor) body = title;
    state.fields = {
      platform,
      mode,
      chapterNumber: mode === "chapter" ? chapterNumber : null,
      title,
      summary: null,
      protagonists: [],
      volumeName: null,
      body,
      combinedEditor,
    };
    return state.fields;
  }

  function setInputValue(element, value) {
    element.focus();
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function chineseNumberToArabic(value) {
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
    let total = 0;
    let section = 0;
    let number = 0;
    for (const character of value) {
      if (Object.hasOwn(digits, character)) {
        number = digits[character];
        continue;
      }
      const unit = units[character];
      if (!unit) return null;
      if (unit === 10000) {
        section += number;
        total += section * unit;
        section = 0;
      } else {
        section += (number || 1) * unit;
      }
      number = 0;
    }
    return total + section + number;
  }

  function normalizeChapterNumber(value) {
    if (!value) return null;
    const halfWidth = value.replace(
      /[０-９]/g,
      (character) => String.fromCharCode(character.charCodeAt(0) - 0xFEE0),
    );
    if (/^\d+$/.test(halfWidth)) return String(Number(halfWidth));
    const converted = chineseNumberToArabic(halfWidth);
    return converted === null ? null : String(converted);
  }

  function parseChapterTitle(value) {
    const title = String(value || "").trim();
    const match = title.match(
      /^\s*(?:第\s*([0-9０-９一二三四五六七八九十百千万零〇两]+)\s*[章回节篇]|chapter\s*([0-9０-９]+))\s*[：:、，,.。\-—_]*\s*/i,
    );
    if (!match) return { chapterNumber: null, title };
    return {
      chapterNumber: normalizeChapterNumber(match[1] || match[2]),
      title: title.slice(match[0].length).trim() || title,
    };
  }

  function normalizeFanqieTitle(value) {
    return parseChapterTitle(value).title;
  }

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function bodyParagraphs(value) {
    const normalized = String(value || "")
      .replace(/\r\n?/g, "\n")
      .trim();
    return normalized
      ? normalized.split(/\n[\t \u3000]*\n+/).map((paragraph) => paragraph.trim()).filter(Boolean)
      : [""];
  }

  function isBodyHeading(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return /^(?:第\s*[0-9０-９一二三四五六七八九十百千万零〇两]+\s*[章回节篇](?:\s+.+)?|chapter\s*[0-9０-９]+(?:\s+.+)?|开篇(?:钩子)?|楔子|序章|前言|尾声|后记|番外(?:\s+.+)?)$/i.test(text);
  }

  function normalizeBodyTypography(value) {
    const punctuation = { ",": "，", "!": "！", "?": "？", ";": "；", ":": "：" };
    return String(value || "")
      .replace(/"([^"\n]+)"/g, "“$1”")
      .replace(/([\u3400-\u9fff])([,!?;:])/g, (match, character, mark) => `${character}${punctuation[mark]}`)
      .replace(/([\u3400-\u9fff])\.(?=\s|$|["“”])/g, "$1。")
      .replace(/[\t ]+([，。！？；：”])/g, "$1");
  }

  function formatBodyParagraph(value) {
    const paragraph = normalizeBodyTypography(value).replace(/^[\t \u3000]+/, "");
    return isBodyHeading(paragraph) ? paragraph : `　　${paragraph}`;
  }

  function formatBodyText(value) {
    return bodyParagraphs(value)
      .map(formatBodyParagraph)
      .join("\n\n");
  }

  function bodyToHtml(value) {
    return bodyParagraphs(value)
      .map((paragraph) => {
        const formatted = formatBodyParagraph(paragraph);
        const tag = isBodyHeading(paragraph) ? "h2" : "p";
        return `<${tag}>${escapeHtml(formatted).replaceAll("\n", "<br>") || "<br>"}</${tag}>`;
      })
      .join("");
  }

  function qimaoChapterBodyToHtml(title, body) {
    const chapterTitle = String(title || "").trim();
    const paragraphs = bodyParagraphs(body);
    const comparable = (value) => String(value || "")
      .replace(/^[\t \u3000]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (chapterTitle && comparable(paragraphs[0]) === comparable(chapterTitle)) paragraphs.shift();
    const bodyHtml = bodyToHtml(paragraphs.join("\n\n"));
    return chapterTitle ? `<h3>${escapeHtml(chapterTitle)}</h3>${bodyHtml}` : bodyHtml;
  }

  function qimaoWholeStoryToHtml(story) {
    const chapters = Array.isArray(story?.chapters) ? story.chapters : [];
    if (chapters.length) {
      return chapters
        .map((chapter) => qimaoChapterBodyToHtml(chapter.title, chapter.body))
        .join("");
    }
    return bodyToHtml(fullStoryBody(story)).replaceAll("<h2>", "<h3>").replaceAll("</h2>", "</h3>");
  }

  function setEditableHtml(element, html) {
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertHTML", false, html);
    if (!inserted || !element.querySelector("p, div, h1, h2, h3")) {
      element.innerHTML = html;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: null }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setEditableValue(element, value) {
    setEditableHtml(element, bodyToHtml(value));
  }

  function fillElement(element, value) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setInputValue(element, value);
      return;
    }
    setEditableValue(element, value);
  }

  function fillBodyElement(element, value) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setInputValue(element, formatBodyText(value));
      return;
    }
    setEditableHtml(element, bodyToHtml(value));
  }

  function fillQimaoChapterBody(element, title, body) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const paragraphs = bodyParagraphs(body);
      const chapterTitle = String(title || "").trim();
      if (chapterTitle && paragraphs[0]?.replace(/^[\t \u3000]+/, "").trim() === chapterTitle) paragraphs.shift();
      const formattedBody = formatBodyText(paragraphs.join("\n\n"));
      setInputValue(element, [chapterTitle, formattedBody].filter(Boolean).join("\n\n"));
      return;
    }
    setEditableHtml(element, qimaoChapterBodyToHtml(title, body));
  }

  function fillTitleElement(element, value) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setInputValue(element, value);
      return;
    }
    setEditableHtml(element, escapeHtml(value));
  }

  function fillEditor(title, body, fallbackChapterNumber = null) {
    const fields = detectEditorFields();
    if (!fields.title || !fields.body) {
      return {
        ok: false,
        chapterNumberFound: Boolean(fields.chapterNumber),
        chapterNumberFilled: false,
        titleFound: Boolean(fields.title),
        bodyFound: Boolean(fields.body),
      };
    }
    const parsed = parseChapterTitle(title);
    const chapterNumber = parsed.chapterNumber || normalizeChapterNumber(String(fallbackChapterNumber || ""));
    if (fields.chapterNumber && chapterNumber) fillElement(fields.chapterNumber, chapterNumber);
    const editorTitle = fields.platform === "qimao" && !fields.chapterNumber
      ? String(title || "").trim()
      : parsed.title;
    fillElement(fields.title, editorTitle);
    if (fields.platform === "qimao") fillQimaoChapterBody(fields.body, title, body);
    else fillBodyElement(fields.body, body);
    return {
      ok: true,
      chapterNumberFound: Boolean(fields.chapterNumber),
      chapterNumberFilled: Boolean(fields.chapterNumber && chapterNumber),
      titleFound: true,
      bodyFound: true,
    };
  }

  function truncateText(value, limit) {
    const characters = Array.from(String(value || "").trim());
    return {
      text: characters.slice(0, limit).join(""),
      truncated: characters.length > limit,
    };
  }

  function storySynopsis(story, limit = 500) {
    const firstBody = story?.chapters?.find((chapter) => chapter.body?.trim())?.body;
    const source = firstBody || fullStoryBody(story);
    const normalized = String(source || "")
      .replace(/\r\n?/g, "\n")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
    return truncateText(normalized, limit).text;
  }

  function countOccurrences(value, term) {
    if (!term) return 0;
    return String(value || "").split(term).length - 1;
  }

  function termScore(title, body, terms) {
    return terms.reduce((score, rule) => {
      const [term, weight = 1] = Array.isArray(rule) ? rule : [rule, 1];
      const titleHits = Math.min(countOccurrences(title, term), 2);
      const bodyHits = Math.min(countOccurrences(body, term), 6);
      return score + titleHits * weight * 4 + bodyHits * weight;
    }, 0);
  }

  function hasTerm(value, terms) {
    return terms.some((term) => String(value || "").includes(term));
  }

  function normalizedPublishingHint(story) {
    const hint = story?.publishingHint;
    if (!hint || typeof hint !== "object") return null;
    const audience = String(hint.audience || "").trim();
    const readingTags = Array.isArray(hint.readingTags)
      ? hint.readingTags.map((tag) => String(tag).trim()).filter(Boolean)
      : [];
    const contentTags = Array.isArray(hint.contentTags)
      ? hint.contentTags.map((tag) => String(tag).trim()).filter(Boolean)
      : [];
    if (!audience && !readingTags.length && !contentTags.length) return null;
    return {
      source: hint.source === "inkos" ? "inkos" : "metadata",
      audience: audience || "方向待定",
      readingTags,
      contentTags,
    };
  }

  function normalizeSettingValues(values, limit) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, limit);
  }

  function suggestTagDimensions(story, workType = suggestWorkType(story)) {
    const configured = story?.publishingHint?.tagDimensions;
    if (configured && typeof configured === "object") {
      return {
        plot: normalizeSettingValues(configured.plot, 4),
        emotion: normalizeSettingValues(configured.emotion, 2),
        persona: normalizeSettingValues(configured.persona, 4),
        worldview: normalizeSettingValues(configured.worldview, 1),
      };
    }

    const title = String(story?.title || "");
    const body = fullStoryBody(story).slice(0, 50000);
    const source = `${title}\n${body}`;
    const plot = [];
    const emotion = [];
    const persona = [];

    if (workType.primary === "悬疑") plot.push("推理");
    if (hasTerm(source, ["调查", "追查", "证据", "审计", "档案", "台账"])) plot.push("调查取证");
    if (hasTerm(source, ["公司", "集团", "职场", "上司", "下属", "项目", "律所"])) plot.push("职场博弈");
    if (hasTerm(source, ["复仇", "报仇", "逆袭", "反杀"])) plot.push("复仇逆袭");
    if (workType.primary === "现代言情") plot.push("情感成长");
    if (workType.primary === "玄幻奇幻") plot.push("升级成长");
    if (workType.primary === "科幻") plot.push("生存冒险");
    if (!plot.length) plot.push("现实成长");

    if (hasTerm(source, ["父亲", "母亲", "父母", "家人", "家庭", "亲人"])) emotion.push("亲情");
    if (hasTerm(source, ["朋友", "友情", "同伴", "战友", "兄弟", "姐妹"])) emotion.push("友情");
    if (workType.primary === "现代言情" || hasTerm(source, ["爱情", "恋爱", "心动", "婚姻", "前夫", "前妻"])) {
      emotion.push("爱情");
    }
    if (!emotion.length) emotion.push("情感克制");

    if (workType.audience === "女频" && hasTerm(source, ["调查", "审计", "证据", "职场", "事业", "独立", "反击"])) {
      persona.push("女强");
    }
    if (hasTerm(source, ["审计", "律师", "医生", "警察", "刑警", "总监", "工程师"])) persona.push("职场精英");
    if (hasTerm(source, ["调查", "核验", "复核", "证据", "推理", "分析"])) persona.push("理性清醒");
    if (hasTerm(source, ["成长", "逆袭", "反击", "坚持", "承担", "保护"])) persona.push("坚韧成长");
    if (!persona.length) persona.push("请按主角设定选择");

    let worldview = "不选（现代现实）";
    if (workType.primary === "玄幻奇幻") worldview = "玄幻世界";
    else if (workType.primary === "古代言情") worldview = "古代世界";
    else if (workType.primary === "科幻") worldview = workType.secondary === "末世危机" ? "末世" : "未来世界";

    return {
      plot: normalizeSettingValues(plot, 4),
      emotion: normalizeSettingValues(emotion, 2),
      persona: normalizeSettingValues(persona, 4),
      worldview: [worldview],
    };
  }

  function suggestWorkType(story) {
    const title = String(story?.title || "");
    const body = fullStoryBody(story).slice(0, 50000);
    const source = `${title}\n${body}`;
    const curated = normalizedPublishingHint(story);
    if (curated) {
      const readingText = curated.readingTags.length ? curated.readingTags.join("、") : "待选择";
      const contentText = curated.contentTags.length ? curated.contentTags.join("、") : "待选择";
      return {
        source: curated.source,
        audience: curated.audience,
        primary: curated.readingTags[0] || "待选择",
        secondary: curated.readingTags[1] || "",
        tags: curated.contentTags,
        readingTags: curated.readingTags,
        contentTags: curated.contentTags,
        text: `${curated.audience}｜阅读标签：${readingText}｜内容标签：${contentText}`,
      };
    }

    const femalePronouns = countOccurrences(body, "她");
    const malePronouns = countOccurrences(body, "他");
    const femaleDirectionScore = termScore(title, body, [
      ["女主", 3], ["前夫", 2], ["丈夫", 2], ["婆婆", 2], ["闺蜜", 2],
      ["王妃", 3], ["嫡女", 3], ["千金", 2], ["追妻", 2],
    ]);
    const maleDirectionScore = termScore(title, body, [
      ["男主", 3], ["前妻", 2], ["赘婿", 3], ["战神", 3], ["奶爸", 2],
      ["校花", 2], ["女总裁", 2], ["岳父", 2], ["岳母", 2],
    ]);
    let audience = "方向待定";
    if (femalePronouns >= 12 && femalePronouns > malePronouns * 1.35) audience = "女频";
    else if (malePronouns >= 12 && malePronouns > femalePronouns * 1.35) audience = "男频";
    else if (femaleDirectionScore >= maleDirectionScore + 4) audience = "女频";
    else if (maleDirectionScore >= femaleDirectionScore + 4) audience = "男频";

    const categoryScores = {
      suspense: termScore(title, body, [
        ["悬疑", 5], ["谜案", 5], ["命案", 5], ["凶手", 4], ["尸体", 4],
        ["破案", 4], ["刑警", 4], ["侦探", 4], ["线索", 3], ["证据", 3],
        ["调查", 3], ["追查", 3], ["真相", 3], ["伪造", 3], ["核验", 2],
        ["审计", 3], ["档案", 2], ["台账", 3], ["签收", 2], ["回执", 2],
        ["诉讼", 2], ["案件", 3], ["火灾", 2],
      ]),
      romance: termScore(title, body, [
        ["言情", 5], ["爱情", 4], ["恋爱", 4], ["心动", 3], ["表白", 3],
        ["甜宠", 5], ["追妻", 4], ["复婚", 4], ["破镜重圆", 5], ["久别重逢", 4],
        ["前夫", 2], ["前妻", 2], ["渣男", 2], ["婚恋", 4], ["暧昧", 3],
      ]),
      fantasy: termScore(title, body, [
        ["玄幻", 5], ["修仙", 5], ["仙尊", 4], ["灵根", 4], ["宗门", 4],
        ["渡劫", 4], ["飞升", 4], ["武魂", 4], ["斗气", 4], ["魔法", 3],
      ]),
      ancient: termScore(title, body, [
        ["古言", 5], ["皇帝", 3], ["王爷", 3], ["王妃", 4], ["侯府", 4],
        ["嫡女", 4], ["庶女", 4], ["后宫", 4], ["朝堂", 3], ["宅斗", 5],
      ]),
      scifi: termScore(title, body, [
        ["科幻", 5], ["末世", 5], ["丧尸", 5], ["星际", 5], ["机甲", 5],
        ["宇宙", 3], ["外星", 4], ["赛博", 4],
      ]),
      workplace: termScore(title, body, [
        ["职场", 5], ["公司", 2], ["集团", 2], ["上司", 3], ["下属", 3],
        ["项目", 2], ["总监", 2], ["审计", 3], ["律所", 3], ["董事会", 3],
      ]),
    };
    const [leadingGenre, leadingGenreScore] = Object.entries(categoryScores)
      .filter(([name]) => name !== "workplace")
      .sort((left, right) => right[1] - left[1])[0];
    const category = leadingGenreScore >= 8
      ? leadingGenre
      : categoryScores.workplace >= 8
        ? "workplace"
        : "urban";
    const categoryScore = category === "urban" ? 0 : categoryScores[category];

    let primary = "都市";
    let secondary = "都市生活";
    if (categoryScore >= 8 && category === "suspense") {
      primary = "悬疑";
      secondary = hasTerm(source, ["都市", "公司", "职场", "旧城", "社区", "审计", "律所"])
        ? "都市悬疑"
        : "推理探案";
    } else if (categoryScore >= 8 && category === "romance") {
      primary = "现代言情";
      secondary = categoryScores.workplace >= 5
        ? "职场婚恋"
        : hasTerm(source, ["豪门", "总裁", "董事长", "千金", "继承人"])
          ? "豪门总裁"
          : "都市情感";
    } else if (categoryScore >= 8 && category === "fantasy") {
      primary = "玄幻奇幻";
      secondary = hasTerm(source, ["修仙", "仙尊", "宗门", "渡劫", "飞升"])
        ? "东方玄幻"
        : "异世大陆";
    } else if (categoryScore >= 8 && category === "ancient") {
      primary = "古代言情";
      secondary = hasTerm(source, ["后宫", "嫡女", "庶女", "侯府", "宅斗"])
        ? "宫斗宅斗"
        : "古代情缘";
    } else if (categoryScore >= 8 && category === "scifi") {
      primary = "科幻";
      secondary = hasTerm(source, ["末世", "丧尸"]) ? "末世危机" : "未来世界";
    } else if (categoryScore >= 8 && category === "workplace") {
      primary = "都市";
      secondary = "职场生活";
    }

    const contentRules = [
      ["调查取证", ["调查", "追查", "线索", "证据", "核验", "审计", "档案", "台账", "伪造", "回执"]],
      ["现实题材", ["旧城", "拆迁", "安置", "住户", "补偿", "社区", "民生", "行政程序"]],
      ["职场博弈", ["职场", "公司", "集团", "房企", "上司", "下属", "项目", "审计", "律所", "董事会"]],
      ["家庭关系", ["父亲", "母亲", "父母", "家庭", "家人", "兄弟", "姐妹"]],
      ["婚恋纠葛", ["离婚", "前夫", "前妻", "婚姻", "复婚", "假离婚"]],
      ["豪门", ["豪门", "总裁", "董事长", "千金", "继承人"]],
      ["久别重逢", ["久别重逢", "多年后", "三年后", "五年后", "再次见到", "重逢"]],
      ["破镜重圆", ["破镜重圆", "复婚", "重新开始", "追回", "追妻"]],
      ["复仇逆袭", ["复仇", "反杀", "逆袭", "打脸", "报仇", "雪恨"]],
      ["重生", ["重生", "前世", "上一世"]],
      ["穿越", ["穿越", "穿书", "异世"]],
      ["系统流", ["绑定系统", "获得系统", "系统提示", "系统任务", "任务奖励", "签到系统", "宿主"]],
    ];
    const contentTags = contentRules
      .map(([tag, terms]) => [tag, termScore(title, body, terms)])
      .filter(([, score]) => score >= 2)
      .sort((left, right) => right[1] - left[1])
      .map(([tag]) => tag)
      .slice(0, 4);
    if (!contentTags.length) contentTags.push(secondary);
    const readingTags = [secondary];

    return {
      source: "inferred",
      audience,
      primary,
      secondary,
      tags: contentTags,
      readingTags,
      contentTags,
      text: `${audience}｜阅读标签：${readingTags.join("、")}｜内容标签：${contentTags.join("、")}`,
    };
  }

  function suggestProtagonists(story, limit = 2) {
    const source = fullStoryBody(story).slice(0, 20000);
    const surnames = "赵钱孙李周吴郑王冯陈蒋沈韩杨朱秦许何吕张曹金魏姜谢邹苏潘范彭鲁韦马方任袁柳史唐薛雷贺倪汤罗郝安常傅齐康伍余顾孟黄穆萧尹姚邵汪毛米贝戴宋庞熊纪舒屈项董梁杜阮蓝季贾路江童郭梅林钟徐邱高夏蔡田樊胡霍万卢莫房裘陆荣翁甄曲封储段巫乌焦侯全白蒲向古易廖阎连艾容石崔龚程邢裴牛温庄柴翟谭蒙乔曾关游权司黎欧阳上官司马诸葛";
    const actionWords = ["没想到", "说道", "说", "问道", "问", "笑道", "笑", "看着", "看", "盯着", "盯", "站在", "站", "坐在", "坐", "走进", "走", "转身", "转", "抬头", "抬", "伸手", "伸", "拿起", "拿", "放下", "放", "点头", "摇头", "沉默", "开口", "皱眉", "脸色", "声音", "眼神", "手机", "没有", "终于", "忽然", "冷冷", "淡淡", "把", "将", "先", "还", "也", "却", "正在", "正", "刚", "在", "继续", "感到", "知道", "听见", "收到", "回"];
    const expression = new RegExp(`((?:欧阳|上官|司马|诸葛)[\\u4e00-\\u9fa5]{1,2}|[${surnames}][\\u4e00-\\u9fa5]{1,2})(?=${actionWords.join("|")})`, "g");
    const invalidNames = new Set(["自己", "有人", "没人", "所有人", "年轻人", "工作人员", "负责人", "当事人"]);
    const invalidSuffix = /先生|女士|小姐|经理|总监|主任|科长|队长|老师|医生|律师|老板|阿姨|叔叔|爸爸|妈妈|父亲|母亲|爷爷|奶奶|总$/;
    const candidates = new Map();
    for (const match of source.matchAll(expression)) {
      let name = match[1];
      const possibleAction = `${name.at(-1)}${source.slice(match.index + name.length, match.index + name.length + 4)}`;
      if (name.length > 2 && actionWords.some((word) => possibleAction.startsWith(word))) {
        name = name.slice(0, -1);
      }
      if (invalidNames.has(name) || invalidSuffix.test(name)) continue;
      const current = candidates.get(name) || { count: 0, index: match.index };
      current.count += 1;
      candidates.set(name, current);
    }
    return [...candidates.entries()]
      .sort((left, right) => right[1].count - left[1].count || left[1].index - right[1].index)
      .slice(0, limit)
      .map(([name]) => name);
  }

  function fillWorkInfo(story) {
    const fields = detectEditorFields();
    if (fields.mode !== "work-info" || !fields.title || !fields.summary) {
      return {
        ok: false,
        titleFound: Boolean(fields.title),
        summaryFound: Boolean(fields.summary),
      };
    }
    const titleLimit = fields.title.maxLength > 0 ? fields.title.maxLength : 18;
    const summaryLimit = fields.summary.maxLength > 0 ? fields.summary.maxLength : 500;
    const title = truncateText(story?.title, titleLimit);
    const protagonists = suggestProtagonists(story);
    fillElement(fields.title, title.text);
    fillElement(fields.summary, storySynopsis(story, summaryLimit));
    fields.protagonists.slice(0, protagonists.length).forEach((element, index) => {
      fillElement(element, protagonists[index]);
    });
    return {
      ok: true,
      titleFound: true,
      summaryFound: true,
      titleTruncated: title.truncated,
      protagonists,
      protagonistFieldsFound: fields.protagonists.length,
      titleLimit,
    };
  }

  function fullStoryBody(story) {
    if (typeof story?.fullText === "string" && story.fullText.trim()) return story.fullText.trim();
    return (story?.chapters || [])
      .map((chapter) => `${chapter.title}\n\n${chapter.body}`.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function fillShortStory(story) {
    const fields = detectEditorFields();
    const titleRequired = fields.platform !== "qimao";
    if (fields.mode !== "short-story" || (titleRequired && !fields.title) || !fields.body) {
      return {
        ok: false,
        mode: fields.mode,
        titleFound: Boolean(fields.title),
        bodyFound: Boolean(fields.body),
      };
    }
    const title = String(story?.title || "").trim();
    const body = fullStoryBody(story);
    if (fields.platform === "qimao") {
      setEditableHtml(fields.body, qimaoWholeStoryToHtml(story));
    } else if (fields.combinedEditor) {
      setEditableHtml(fields.body, `<h1>${escapeHtml(title)}</h1>${bodyToHtml(body)}`);
    } else {
      fillTitleElement(fields.title, title);
      fillBodyElement(fields.body, body);
    }
    return {
      ok: true,
      mode: "short-story",
      titleFound: true,
      bodyFound: true,
      combinedEditor: fields.combinedEditor,
      chapterCount: story?.chapters?.length || 0,
      characters: body.replace(/\s/g, "").length,
    };
  }

  function normalizedStoryVolumes(story) {
    if (Array.isArray(story?.volumes) && story.volumes.length) return story.volumes;
    const chapterCount = Math.max(story?.chapters?.length || 0, 1);
    return [{ number: 1, title: "默认", startChapter: 1, endChapter: chapterCount }];
  }

  function fillVolumeName(story, volumeIndex = 0) {
    const fields = detectEditorFields();
    const volume = normalizedStoryVolumes(story)[volumeIndex];
    if (fields.mode !== "volume-manage" || !fields.volumeName || !volume) {
      return { ok: false, volumeNameFound: Boolean(fields.volumeName), volumeFound: Boolean(volume) };
    }
    const limit = fields.volumeName.maxLength > 0 ? fields.volumeName.maxLength : 30;
    const title = truncateText(volume.title, limit);
    fillElement(fields.volumeName, title.text);
    return { ok: true, titleTruncated: title.truncated, titleLimit: limit, volume };
  }

  function storyCoverUrl(story) {
    if (typeof story?.cover === "string") return story.cover;
    return typeof story?.cover?.url === "string" ? story.cover.url : "";
  }

  async function fetchCoverDataUrl(story) {
    const coverUrl = storyCoverUrl(story);
    if (!coverUrl) throw new Error("当前作品没有封面");
    if (coverUrl.startsWith("data:image/")) return coverUrl;
    const response = await chrome.runtime.sendMessage({ type: "FETCH_COVER", coverUrl });
    if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "封面读取失败");
    return response.dataUrl;
  }

  async function svgBlobToPng(blob) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = objectUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 768;
      canvas.height = 1024;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error("SVG 封面转 PNG 失败")), "image/png", 0.94);
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function coverFile(story) {
    const dataUrl = await fetchCoverDataUrl(story);
    let blob = await (await fetch(dataUrl)).blob();
    if (blob.type === "image/svg+xml") blob = await svgBlobToPng(blob);
    if (!blob.type.startsWith("image/")) throw new Error("封面数据不是图片");
    const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
    const safeTitle = String(story?.title || "reader-cover").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 60);
    return new File([blob], `${safeTitle}-封面.${extension}`, { type: blob.type, lastModified: Date.now() });
  }

  async function fillCover(story) {
    const input = findCoverInput();
    if (!input) return { ok: false, inputFound: false, coverFound: Boolean(storyCoverUrl(story)) };
    const file = await coverFile(story);
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, inputFound: true, coverFound: true, file };
  }

  const panelMarkup = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel { width: 340px; color: #17201d; background: #f7f8f5; border: 1px solid #cad4d0; border-radius: 8px; box-shadow: 0 14px 44px rgba(10, 40, 32, .22); font-family: "Microsoft YaHei", system-ui, sans-serif; overflow: hidden; }
      .header { min-height: 52px; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #143f36; color: #fff; }
      .header strong { font-size: 15px; font-weight: 650; }
      .header button { width: 30px; height: 30px; padding: 0; border: 1px solid rgba(255,255,255,.35); border-radius: 5px; background: transparent; color: #fff; cursor: pointer; }
      .body { padding: 14px; }
      .panel.collapsed .body { display: none; }
      label { display: block; margin-top: 10px; color: #60706b; font-size: 11px; font-weight: 600; }
      label:first-child { margin-top: 0; }
      .mode-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; color: #60706b; font-size: 11px; }
      .mode-row strong { color: #143f36; font-size: 12px; }
      .mode-row + label { margin-top: 0; }
      select { width: 100%; min-height: 40px; margin-top: 5px; padding: 0 34px 0 10px; border: 1px solid #cad4d0; border-radius: 5px; background: #fff; color: #17201d; font: inherit; font-size: 13px; }
      .status { margin: 12px 0 0; padding: 9px 10px; border-left: 3px solid #e75b3f; background: #fff; color: #4c5b56; font-size: 12px; line-height: 1.5; }
      .type-suggestion { display: none; margin-top: 10px; padding: 9px 10px; border: 1px solid #cad4d0; border-radius: 5px; background: #fff; }
      .panel.work-info .type-suggestion, .panel.short-story .type-suggestion { display: block; }
      .type-suggestion span { display: block; color: #71807b; font-size: 11px; }
      .type-suggestion strong { display: block; margin-top: 5px; color: #143f36; font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
      .type-suggestion small { display: block; margin-top: 4px; color: #8a9692; font-size: 10px; line-height: 1.4; }
      .protagonist-suggestion { display: none; margin-top: 8px; padding: 9px 10px; border: 1px solid #cad4d0; border-radius: 5px; background: #fff; }
      .panel.work-info .protagonist-suggestion { display: block; }
      .protagonist-suggestion span { display: block; color: #71807b; font-size: 11px; }
      .protagonist-suggestion strong { display: block; margin-top: 5px; color: #143f36; font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
      .protagonist-suggestion small { display: block; margin-top: 4px; color: #8a9692; font-size: 10px; line-height: 1.4; }
      .tag-settings { display: none; margin-top: 8px; padding: 9px 10px; border: 1px solid #cad4d0; border-radius: 5px; background: #fff; }
      .panel.work-info .tag-settings { display: block; }
      .tag-settings > span { display: block; color: #71807b; font-size: 11px; }
      .settings-grid { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 5px 8px; margin-top: 6px; align-items: start; }
      .settings-grid b { color: #71807b; font-size: 11px; font-weight: 500; line-height: 1.55; }
      .settings-grid strong { color: #143f36; font-size: 12px; font-weight: 650; line-height: 1.55; overflow-wrap: anywhere; }
      .tag-settings small { display: block; margin-top: 5px; color: #8a9692; font-size: 10px; line-height: 1.4; }
      .cover-tools { display: none; margin-top: 10px; padding: 9px; grid-template-columns: 54px minmax(0, 1fr); gap: 10px; align-items: center; border: 1px solid #cad4d0; border-radius: 5px; background: #fff; }
      .panel.work-info .cover-tools, .panel.short-story .cover-tools { display: grid; }
      .cover-preview { width: 54px; height: 72px; display: block; object-fit: cover; border-radius: 3px; background: #dce5e1; }
      .cover-copy span { display: block; color: #71807b; font-size: 11px; }
      .cover-copy small { display: block; margin-top: 3px; color: #8a9692; font-size: 10px; line-height: 1.35; }
      .cover-fill { width: 100%; min-height: 34px; margin-top: 7px; border: 1px solid #143f36; border-radius: 4px; background: #fff; color: #143f36; font: inherit; font-size: 11px; font-weight: 650; cursor: pointer; }
      .actions { margin-top: 12px; display: grid; grid-template-columns: 40px minmax(0, 1fr) 40px; gap: 7px; }
      .actions button, .refresh { min-height: 40px; border: 1px solid #143f36; border-radius: 5px; background: #143f36; color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .actions .step { padding: 0; background: #fff; color: #143f36; font-size: 18px; }
      .panel.whole-story .chapter-row, .panel.whole-story .step { display: none; }
      .panel.whole-story .actions { grid-template-columns: minmax(0, 1fr); }
      .volume-row { display: none; }
      .panel.volume-manage .volume-row { display: block; }
      .refresh { width: 100%; margin-top: 8px; border-color: #cad4d0; background: #fff; color: #143f36; font-size: 12px; }
      button:disabled { opacity: .45; cursor: not-allowed; }
      .meta { margin-top: 8px; display: flex; justify-content: space-between; color: #71807b; font-size: 11px; }
      @media (max-width: 700px) { .panel { width: min(340px, calc(100vw - 24px)); } }
    </style>
    <section class="panel">
      <header class="header"><strong>Reader 导入助手</strong><button class="collapse" type="button" aria-label="收起面板">−</button></header>
      <div class="body">
        <div class="mode-row"><span>导入模式</span><strong class="mode">正在检测…</strong></div>
        <label>作品<select class="story"></select></label>
        <label class="chapter-row">章节<select class="chapter"></select></label>
        <label class="volume-row">分卷<select class="volume"></select></label>
        <div class="meta"><span class="position"></span><span class="characters"></span></div>
        <div class="type-suggestion"><span>建议作品类型</span><strong class="suggestion"></strong><small class="type-source"></small></div>
        <div class="tag-settings">
          <span>番茄内容标签设定</span>
          <div class="settings-grid">
            <b>情节 · 4</b><strong class="plot-settings"></strong>
            <b>情感 · 2</b><strong class="emotion-settings"></strong>
            <b>人设 · 4</b><strong class="persona-settings"></strong>
            <b>世界观 · 1</b><strong class="worldview-settings"></strong>
          </div>
          <small>按页面搜索最接近的标签；“不选”表示现实背景无需强加特殊世界观。</small>
        </div>
        <div class="protagonist-suggestion"><span>建议主角名</span><strong class="protagonists"></strong><small>根据正文中的姓名出现频率提取，请核对后使用。</small></div>
        <div class="cover-tools">
          <img class="cover-preview" alt="当前作品封面">
          <div class="cover-copy"><span>对应封面</span><small>只选择图片，保存和发布仍由你确认。</small><button class="cover-fill" type="button">填入封面</button></div>
        </div>
        <p class="status">正在读取作品…</p>
        <div class="actions">
          <button class="step previous" type="button" aria-label="上一章">←</button>
          <button class="fill" type="button">填入当前章节</button>
          <button class="step next" type="button" aria-label="下一章">→</button>
        </div>
        <button class="refresh" type="button">重新读取并检测编辑器</button>
      </div>
    </section>`;

  let ui;

  function currentChapter() {
    return state.activeStory?.chapters[state.activeChapterIndex] || null;
  }

  function currentVolume() {
    return normalizedStoryVolumes(state.activeStory)[state.activeVolumeIndex] || null;
  }

  async function saveState(extra = {}) {
    if (!globalThis.chrome?.storage?.local) return;
    await chrome.storage.local.set({
      storyId: state.activeStory?.id || "",
      chapterIndex: state.activeChapterIndex,
      volumeIndex: state.activeVolumeIndex,
      ...extra,
    });
  }

  function updateStatus(message, kind = "normal") {
    ui.status.textContent = message;
    ui.status.style.borderLeftColor = kind === "error" ? "#b42318" : kind === "success" ? "#1f7a57" : "#e75b3f";
  }

  function detectionSignature(fields) {
    return [
      fields.mode,
      Boolean(fields.chapterNumber),
      Boolean(fields.title),
      Boolean(fields.summary),
      fields.protagonists?.length || 0,
      Boolean(fields.volumeName),
      Boolean(fields.body),
      Boolean(fields.combinedEditor),
    ].join(":");
  }

  function showDetectionStatus(fields) {
    if (fields.mode === "volume-manage") {
      const volume = currentVolume();
      updateStatus(
        fields.volumeName
          ? `已识别分卷名称框，准备填入“${volume?.title || ""}”。保存操作由你确认。`
          : "已进入番茄分卷模式。请选择目标分卷，点击页面上的“编辑分卷”或“新建分卷”，再由助手填入卷名。",
        fields.volumeName ? "success" : "normal",
      );
      return;
    }
    if (fields.mode === "work-info") {
      const platformName = fields.platform === "qimao" ? "七猫" : "番茄";
      updateStatus(
        `已进入${platformName}作品信息模式。作品名称框${fields.title ? "已识别" : "未识别"}，简介框${fields.summary ? "已识别" : "未识别"}，主角名框识别到 ${fields.protagonists.length} 个。`,
        fields.title && fields.summary ? "success" : "error",
      );
      return;
    }
    if (fields.mode === "short-story") {
      if (fields.platform === "qimao") {
        updateStatus(
          `已进入七猫短故事模式。正文框${fields.body ? "已识别" : "未识别"}，将一次填入整篇作品。`,
          fields.body ? "success" : "error",
        );
        return;
      }
      updateStatus(
        `已进入短故事模式。故事名称框${fields.title ? "已识别" : "未识别"}，正文框${fields.body ? "已识别" : "未识别"}。`,
        fields.title && fields.body ? "success" : "error",
      );
      return;
    }
    const platformName = fields.platform === "qimao" ? "七猫" : "番茄";
    updateStatus(
      `已读取 ${state.stories.length} 篇作品。${platformName}章节标题框${fields.title ? "已识别" : "未识别"}，正文框${fields.body ? "已识别" : "未识别"}。`,
      fields.title && fields.body ? "success" : "error",
    );
  }

  let editorObserver = null;
  let editorDetectionTimer = null;

  function watchEditorChanges() {
    if (editorObserver || !document.body) return;
    editorObserver = new MutationObserver(() => {
      clearTimeout(editorDetectionTimer);
      editorDetectionTimer = setTimeout(() => {
        if (!state.activeStory) return;
        const previousSignature = detectionSignature(state.fields);
        const fields = detectEditorFields();
        if (detectionSignature(fields) === previousSignature) return;
        setEditorMode(fields.mode);
        showDetectionStatus(fields);
      }, 250);
    });
    editorObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
      childList: true,
      subtree: true,
    });
  }

  function renderChapters() {
    ui.chapter.replaceChildren();
    state.activeStory.chapters.forEach((chapter, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = chapter.title;
      ui.chapter.append(option);
    });
    state.activeChapterIndex = Math.min(state.activeChapterIndex, state.activeStory.chapters.length - 1);
    ui.chapter.value = String(state.activeChapterIndex);
    renderVolumes();
    renderChapterMeta();
    renderWorkTypeSuggestion();
  }

  function renderVolumes() {
    const volumes = normalizedStoryVolumes(state.activeStory);
    ui.volume.replaceChildren();
    volumes.forEach((volume, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `第${volume.number}卷 · ${volume.title}`;
      ui.volume.append(option);
    });
    state.activeVolumeIndex = Math.min(state.activeVolumeIndex, volumes.length - 1);
    ui.volume.value = String(state.activeVolumeIndex);
  }

  function renderChapterMeta() {
    if (state.fields.mode === "volume-manage") {
      const volume = currentVolume();
      const publishedCount = state.activeStory?.chapters?.filter(
        (chapter) => chapter.volume?.number === volume?.number,
      ).length || 0;
      ui.position.textContent = volume
        ? `第${volume.number}卷 · 第${volume.startChapter}–${volume.endChapter}章`
        : "未配置分卷";
      ui.characters.textContent = `已收录 ${publishedCount} 章`;
      ui.previous.disabled = true;
      ui.next.disabled = true;
      return;
    }
    if (state.fields.mode === "work-info") {
      const characters = Number(state.activeStory?.characters) || fullStoryBody(state.activeStory).replace(/\s/g, "").length;
      ui.position.textContent = `新建作品 · ${state.activeStory?.chapters?.length || 0} 个章节`;
      ui.characters.textContent = `${characters.toLocaleString("zh-CN")} 字`;
      ui.previous.disabled = true;
      ui.next.disabled = true;
      return;
    }
    if (state.fields.mode === "short-story") {
      const body = fullStoryBody(state.activeStory);
      const characters = Number(state.activeStory?.characters) || body.replace(/\s/g, "").length;
      ui.position.textContent = `整篇 · ${state.activeStory?.chapters?.length || 0} 个章节`;
      ui.characters.textContent = `${characters.toLocaleString("zh-CN")} 字`;
      ui.previous.disabled = true;
      ui.next.disabled = true;
      return;
    }
    const chapter = currentChapter();
    if (!chapter) return;
    const volumeText = chapter.volume ? `第${chapter.volume.number}卷 · ` : "";
    ui.position.textContent = `${volumeText}${state.activeChapterIndex + 1} / ${state.activeStory.chapters.length}`;
    ui.characters.textContent = `${chapter.characters.toLocaleString("zh-CN")} 字`;
    ui.previous.disabled = state.activeChapterIndex === 0;
    ui.next.disabled = state.activeChapterIndex === state.activeStory.chapters.length - 1;
  }

  function renderWorkTypeSuggestion() {
    if (!ui?.suggestion || !state.activeStory) return;
    const workType = suggestWorkType(state.activeStory);
    const settings = suggestTagDimensions(state.activeStory, workType);
    ui.suggestion.textContent = workType.text;
    ui.typeSource.textContent = workType.source === "inkos"
      ? "标签来源：InkOS book.json（大纲、角色卡与世界观）"
      : workType.source === "metadata"
        ? "标签来源：作品结构化元数据"
        : "标签来源：旧作品正文推断；该作品没有 InkOS 发布分类。";
    ui.plotSettings.textContent = settings.plot.length ? settings.plot.join("、") : "不选";
    ui.emotionSettings.textContent = settings.emotion.length ? settings.emotion.join("、") : "不选";
    ui.personaSettings.textContent = settings.persona.length ? settings.persona.join("、") : "不选";
    ui.worldviewSettings.textContent = settings.worldview.length ? settings.worldview.join("、") : "不选";
    const protagonists = suggestProtagonists(state.activeStory);
    ui.protagonists.textContent = protagonists.length ? protagonists.join("、") : "未识别到明确人名，请手动填写";
  }

  let coverPreviewRequest = 0;
  async function renderCoverPreview() {
    const request = ++coverPreviewRequest;
    ui.coverPreview.removeAttribute("src");
    ui.coverFill.disabled = !storyCoverUrl(state.activeStory);
    if (!storyCoverUrl(state.activeStory)) {
      ui.coverPreview.alt = "当前作品没有封面";
      return;
    }
    try {
      const dataUrl = await fetchCoverDataUrl(state.activeStory);
      if (request === coverPreviewRequest) ui.coverPreview.src = dataUrl;
    } catch {
      if (request === coverPreviewRequest) ui.coverPreview.alt = "封面读取失败";
    }
  }

  function setEditorMode(mode) {
    const platformName = state.fields.platform === "qimao" ? "七猫" : "番茄";
    const wholeStory = mode === "short-story" || mode === "work-info" || mode === "volume-manage";
    ui.panel.classList.toggle("whole-story", wholeStory);
    ui.panel.classList.toggle("work-info", mode === "work-info");
    ui.panel.classList.toggle("short-story", mode === "short-story");
    ui.panel.classList.toggle("volume-manage", mode === "volume-manage");
    ui.mode.textContent = mode === "work-info"
      ? `${platformName} · 作品信息`
      : mode === "short-story"
        ? `${platformName} · 短故事`
        : mode === "volume-manage"
          ? `${platformName} · 分卷`
          : `${platformName} · 章节`;
    ui.fill.textContent = mode === "work-info"
      ? "填入作品信息"
      : mode === "short-story"
        ? "填入整篇短故事"
        : mode === "volume-manage"
          ? "填入分卷名称"
          : "填入当前章节";
    renderChapterMeta();
    renderWorkTypeSuggestion();
    renderCoverPreview();
  }

  function selectStory(storyId) {
    state.activeStory = state.stories.find((story) => story.id === storyId) || state.stories[0];
    state.activeChapterIndex = 0;
    state.activeVolumeIndex = 0;
    ui.story.value = state.activeStory.id;
    renderChapters();
    saveState();
  }

  function selectChapter(index) {
    state.activeChapterIndex = Math.min(Math.max(Number(index), 0), state.activeStory.chapters.length - 1);
    ui.chapter.value = String(state.activeChapterIndex);
    renderChapterMeta();
    saveState();
  }

  function selectVolume(index) {
    state.activeVolumeIndex = Math.min(
      Math.max(Number(index), 0),
      normalizedStoryVolumes(state.activeStory).length - 1,
    );
    ui.volume.value = String(state.activeVolumeIndex);
    renderChapterMeta();
    showDetectionStatus(state.fields);
    saveState();
  }

  async function getStoredState() {
    if (!globalThis.chrome?.storage?.local) return STORAGE_DEFAULTS;
    return chrome.storage.local.get(STORAGE_DEFAULTS);
  }

  async function fetchLibrary() {
    if (globalThis.__READER_TEST_LIBRARY__) {
      return { ok: true, payload: globalThis.__READER_TEST_LIBRARY__ };
    }
    return chrome.runtime.sendMessage({ type: "FETCH_LIBRARY" });
  }

  async function loadLibrary() {
    updateStatus("正在读取作品并检测编辑器…");
    const [response, stored] = await Promise.all([fetchLibrary(), getStoredState()]);
    if (!response?.ok) {
      updateStatus(`作品读取失败：${response?.error || "未知错误"}`, "error");
      return;
    }

    state.stories = response.payload.stories;
    ui.story.replaceChildren();
    state.stories.forEach((story) => {
      const option = document.createElement("option");
      option.value = story.id;
      option.textContent = `${story.date ? `${story.date} · ` : ""}${story.title}`;
      ui.story.append(option);
    });

    state.activeStory = state.stories.find((story) => story.id === stored.storyId) || state.stories[0];
    state.activeChapterIndex = Math.min(Number(stored.chapterIndex) || 0, state.activeStory.chapters.length - 1);
    state.activeVolumeIndex = Math.min(
      Number(stored.volumeIndex) || 0,
      normalizedStoryVolumes(state.activeStory).length - 1,
    );
    ui.story.value = state.activeStory.id;
    renderChapters();
    const fields = detectEditorFields();
    setEditorMode(fields.mode);
    showDetectionStatus(fields);
  }

  function mountPanel() {
    if (document.getElementById(ROOT_ID)) return;
    const host = document.createElement("div");
    host.id = ROOT_ID;
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = panelMarkup;
    document.documentElement.append(host);

    ui = {
      panel: shadow.querySelector(".panel"),
      collapse: shadow.querySelector(".collapse"),
      mode: shadow.querySelector(".mode"),
      story: shadow.querySelector(".story"),
      chapter: shadow.querySelector(".chapter"),
      volume: shadow.querySelector(".volume"),
      position: shadow.querySelector(".position"),
      characters: shadow.querySelector(".characters"),
      suggestion: shadow.querySelector(".suggestion"),
      typeSource: shadow.querySelector(".type-source"),
      plotSettings: shadow.querySelector(".plot-settings"),
      emotionSettings: shadow.querySelector(".emotion-settings"),
      personaSettings: shadow.querySelector(".persona-settings"),
      worldviewSettings: shadow.querySelector(".worldview-settings"),
      protagonists: shadow.querySelector(".protagonists"),
      coverPreview: shadow.querySelector(".cover-preview"),
      coverFill: shadow.querySelector(".cover-fill"),
      status: shadow.querySelector(".status"),
      previous: shadow.querySelector(".previous"),
      next: shadow.querySelector(".next"),
      fill: shadow.querySelector(".fill"),
      refresh: shadow.querySelector(".refresh"),
    };

    ui.story.addEventListener("change", () => selectStory(ui.story.value));
    ui.chapter.addEventListener("change", () => selectChapter(ui.chapter.value));
    ui.volume.addEventListener("change", () => selectVolume(ui.volume.value));
    ui.previous.addEventListener("click", () => selectChapter(state.activeChapterIndex - 1));
    ui.next.addEventListener("click", () => selectChapter(state.activeChapterIndex + 1));
    ui.refresh.addEventListener("click", loadLibrary);
    ui.coverFill.addEventListener("click", async () => {
      ui.coverFill.disabled = true;
      updateStatus("正在读取并准备当前作品封面…");
      try {
        const result = await fillCover(state.activeStory);
        if (!result.ok) {
          updateStatus(
            result.coverFound
              ? "未识别封面上传框。请先点击页面上的“封面制作”“选择封面”或加号，再重试。"
              : "当前作品没有可用封面。",
            "error",
          );
        } else {
          updateStatus(`封面“${result.file.name}”已送入上传框，请预览核对后手动保存。`, "success");
        }
      } catch (error) {
        updateStatus(`封面填入失败：${error.message}`, "error");
      } finally {
        ui.coverFill.disabled = !storyCoverUrl(state.activeStory);
      }
    });
    ui.fill.addEventListener("click", () => {
      const fields = detectEditorFields();
      setEditorMode(fields.mode);
      if (fields.mode === "volume-manage") {
        const result = fillVolumeName(state.activeStory, state.activeVolumeIndex);
        if (result.ok) {
          updateStatus(
            result.titleTruncated
              ? `卷名超过平台 ${result.titleLimit} 字限制，已截短填入；请核对后手动保存。`
              : `第${result.volume.number}卷“${result.volume.title}”已填入；请核对章节范围后手动保存。`,
            result.titleTruncated ? "error" : "success",
          );
        } else {
          updateStatus(
            result.volumeFound
              ? "未识别分卷名称框。请先点击页面上的“编辑分卷”或“新建分卷”，再重试。"
              : "当前作品没有分卷规划。",
            "error",
          );
        }
        return;
      }
      if (fields.mode === "work-info") {
        const result = fillWorkInfo(state.activeStory);
        if (result.ok) {
          const protagonistMessage = result.protagonists.length
            ? result.protagonistFieldsFound
              ? `主角名“${result.protagonists.join("、")}”已填入，请核对。`
              : `已提取主角名“${result.protagonists.join("、")}”，但未识别主角名输入框。`
            : "未提取到明确主角名，请手动填写。";
          updateStatus(
            result.titleTruncated
              ? `作品名称超过平台 ${result.titleLimit} 字限制，已截短；简介草稿已填入。${protagonistMessage}`
              : `作品名称和简介草稿已填入。${protagonistMessage} 请补充分类、标签等信息并核对后，再手动保存。`,
            result.titleTruncated ? "error" : "success",
          );
        } else {
          const missing = [!result.titleFound && "作品名称框", !result.summaryFound && "简介框"].filter(Boolean).join("、");
          const platformName = fields.platform === "qimao" ? "七猫" : "番茄";
          updateStatus(`未识别${missing}。请打开${platformName}作品信息页后重新检测。`, "error");
        }
        return;
      }
      if (fields.mode === "short-story") {
        const result = fillShortStory(state.activeStory);
        if (result.ok) {
          if (fields.platform === "qimao") {
            const lengthWarning = result.characters < 4000 || result.characters > 70000
              ? ` 当前约 ${result.characters.toLocaleString("zh-CN")} 字，超出七猫 4000–70000 字范围，请调整。`
              : "";
            updateStatus(
              `整篇短故事已一次填入，共 ${result.chapterCount} 章；每章标题已设为标题格式。${lengthWarning} 请核对后手动保存或发布。`,
              lengthWarning ? "error" : "success",
            );
          } else {
            updateStatus("短故事名称和整篇正文已填入，请核对后在番茄后台保存或进入下一步。", "success");
          }
        } else {
          const missing = [fields.platform !== "qimao" && !result.titleFound && "故事名称框", !result.bodyFound && "正文框"].filter(Boolean).join("、");
          updateStatus(`未识别${missing}。请打开短故事编辑页后重新检测。`, "error");
        }
        return;
      }
      const chapter = currentChapter();
      if (!chapter) return;
      const result = fillEditor(chapter.title, chapter.body, state.activeChapterIndex + 1);
      if (result.ok) {
        if (fields.platform === "qimao") {
          updateStatus("七猫章节标题已作为正文标题写入，正文也已填入，请核对后手动保存或发布。", "success");
        } else {
          updateStatus(
            result.chapterNumberFilled
              ? "章序号、标题和正文已填入，请核对后在番茄后台保存或发布。"
              : "标题和正文已填入，但未识别章序号框，请手动填写章序号。",
            result.chapterNumberFilled ? "success" : "error",
          );
        }
      } else {
        const missing = [!result.titleFound && "标题框", !result.bodyFound && "正文框"].filter(Boolean).join("、");
        updateStatus(`未识别${missing}。请先打开章节编辑页，再重新检测。`, "error");
      }
    });
    ui.collapse.addEventListener("click", () => {
      const collapsed = ui.panel.classList.toggle("collapsed");
      ui.collapse.textContent = collapsed ? "+" : "−";
      ui.collapse.setAttribute("aria-label", collapsed ? "展开面板" : "收起面板");
      saveState({ collapsed });
    });

    getStoredState().then((stored) => {
      ui.panel.classList.toggle("collapsed", Boolean(stored.collapsed));
      ui.collapse.textContent = stored.collapsed ? "+" : "−";
    });
    loadLibrary().then(watchEditorChanges);
  }

  globalThis.__readerFanqieImporter = {
    bodyToHtml,
    detectEditorFields,
    fillEditor,
    fillCover,
    fillShortStory,
    fillWorkInfo,
    fillVolumeName,
    formatBodyText,
    fullStoryBody,
    normalizeFanqieTitle,
    parseChapterTitle,
    storySynopsis,
    suggestProtagonists,
    suggestWorkType,
    suggestTagDimensions,
  };
  globalThis.__readerPublisherImporter = globalThis.__readerFanqieImporter;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
  } else {
    mountPanel();
  }
})();
