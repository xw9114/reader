(() => {
  const ROOT_ID = "reader-fanqie-importer";
  const STORAGE_DEFAULTS = { storyId: "", chapterIndex: 0, collapsed: false };
  const state = {
    stories: [],
    activeStory: null,
    activeChapterIndex: 0,
    fields: {
      platform: "fanqie",
      mode: "chapter",
      chapterNumber: null,
      title: null,
      summary: null,
      protagonists: [],
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
    if (/作品名称|书名|请输入作品名称|book.?title/.test(text)) score += 22;
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

  function protagonistScore(element) {
    const text = fieldText(element);
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (/主角名|主角姓名|角色名|人物名/.test(text)) score += 24;
    if (/作品名称|书名|简介|章节|搜索/.test(text)) score -= 18;
    if (element instanceof HTMLInputElement) score += 5;
    if (rect.height <= 80 && rect.width >= 160) score += 3;
    return score;
  }

  function findProtagonistFields(excludedTitle = null) {
    const inputSelector = "input:not([type]), input[type='text']";
    const found = [...document.querySelectorAll(inputSelector)]
      .filter((element) => element !== excludedTitle && isVisible(element) && protagonistScore(element) >= 20);
    const labels = [...document.querySelectorAll("label, span, p, div, [class*='label']")]
      .filter((element) => isVisible(element) && /^主角名(?:称)?$/.test(String(element.textContent || "").trim()))
      .sort((left, right) => left.childElementCount - right.childElementCount);
    for (const label of labels) {
      let container = label;
      for (let depth = 0; depth < 5 && container; depth += 1, container = container.parentElement) {
        const inputs = [...container.querySelectorAll(inputSelector)]
          .filter((element) => element !== excludedTitle && isVisible(element));
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
    const sideRegion = element.closest("aside, [class*='sidebar'], [class*='side-bar'], [class*='note'], [class*='memo']");
    const sideText = `${sideRegion?.getAttribute("class") || ""} ${sideRegion?.textContent?.slice(0, 240) || ""}`.toLowerCase();
    let score = 0;
    if (/正文|章节内容|内容|请输入正文|content|editor/.test(text)) score += 10;
    if (/简介|搜索|标题|书名|短故事名称|故事名称/.test(text)) score -= 12;
    if (/随记|笔记|资料|灵感|润色|起名|note|memo|sidebar|side-bar/.test(`${text} ${sideText}`)) score -= 32;
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

  function detectEditorFields() {
    const platform = currentPlatform();
    const pageText = document.body?.innerText || "";
    const pageLooksLikeWorkInfo = platform === "qimao"
      && /作品信息/.test(pageText)
      && /作品名称/.test(pageText)
      && /作品简介/.test(pageText);
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
        body: null,
        combinedEditor: false,
      };
      return state.fields;
    }
    const pathname = currentPathname();
    const fanqieShortPath = platform === "fanqie" && /\/publish-short(?:\/|$)/.test(pathname);
    const fanqieChapterPath = platform === "fanqie" && /\/publish(?:\/|$)/.test(pathname);
    const pageLooksLikeShortStory = /未命名短故事|请输入短故事名称/.test(pageText);
    const mode = fanqieShortPath
      ? "short-story"
      : fanqieChapterPath
        ? "chapter"
        : pageLooksLikeShortStory
          ? "short-story"
          : "chapter";
    const chapterNumber = bestCandidate(
      "input:not([type]), input[type='text'], input[type='number'], [contenteditable='true']",
      chapterNumberScore,
    );
    const shortStorySelector = "input:not([type]), input[type='text'], textarea, [contenteditable='true'], [role='textbox']";
    const shortStoryTitle = mode === "short-story"
      ? bestCandidate(shortStorySelector, shortStoryTitleScore, chapterNumber)
        || bestCandidate(shortStorySelector, shortStoryFallbackScore, chapterNumber)
      : null;
    const chapterTitle = bestCandidate(
      "input:not([type]), input[type='text'], textarea, [contenteditable='true'], [role='textbox']",
      titleScore,
      chapterNumber,
    );
    const title = mode === "short-story" ? shortStoryTitle || chapterTitle : chapterTitle;
    let body = bestCandidate(
      "[contenteditable='true'], textarea, [role='textbox']",
      bodyScore,
      title,
    );
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

  function bodyToHtml(value) {
    const normalized = String(value || "")
      .replace(/\r\n?/g, "\n")
      .trim();
    const paragraphs = normalized
      ? normalized.split(/\n[\t \u3000]*\n+/).map((paragraph) => paragraph.trim()).filter(Boolean)
      : [""];
    return paragraphs
      .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>") || "<br>"}</p>`)
      .join("");
  }

  function setEditableHtml(element, html) {
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertHTML", false, html);
    if (!inserted || !element.querySelector("p, div, h1")) {
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
    fillElement(fields.body, body);
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

  function hasAny(value, expressions) {
    return expressions.some((expression) => expression.test(value));
  }

  function signalScore(title, body, expression) {
    return (expression.test(title) ? 3 : 0) + (expression.test(body) ? 1 : 0);
  }

  function suggestWorkType(story) {
    const title = String(story?.title || "");
    const body = fullStoryBody(story).slice(0, 12000);
    const source = `${title}\n${body}`;
    const femaleSignals = /前夫|渣男|丈夫|老公|婆婆|闺蜜|怀孕|王妃|嫡女|千金|夫人|追妻/;
    const maleSignals = /前妻|老婆|赘婿|战神|奶爸|校花|女总裁|岳父|岳母|兄弟|她才知道我是/;
    const femaleScore = signalScore(title, body, femaleSignals);
    const maleScore = signalScore(title, body, maleSignals);
    const audience = femaleScore > maleScore ? "女频" : maleScore > femaleScore ? "男频" : "方向待定";

    let primary = "都市";
    let secondary = "都市生活";
    if (hasAny(source, [/修仙|仙尊|灵根|宗门|渡劫|飞升|灵气/, /玄幻|武魂|斗气|魔法|异世界/])) {
      primary = "玄幻奇幻";
      secondary = hasAny(source, [/修仙|仙尊|宗门|渡劫|飞升/]) ? "东方玄幻" : "异世大陆";
    } else if (hasAny(source, [/皇帝|王爷|王妃|侯府|嫡女|庶女|后宫|朝堂|古代/])) {
      primary = "古代言情";
      secondary = hasAny(source, [/后宫|嫡女|庶女|侯府|宅斗/]) ? "宫斗宅斗" : "古代情缘";
    } else if (hasAny(source, [/末世|丧尸|星际|机甲|宇宙|外星|赛博/])) {
      primary = "科幻";
      secondary = hasAny(source, [/末世|丧尸/]) ? "末世危机" : "未来世界";
    } else if (hasAny(source, [/凶手|命案|尸体|破案|刑警|侦探|悬疑|谜案/])) {
      primary = "悬疑";
      secondary = "推理探案";
    } else if (audience === "女频" || hasAny(source, [/爱情|恋爱|婚姻|离婚|前夫|丈夫|老公|男友|女友/])) {
      primary = "现代言情";
      secondary = hasAny(source, [/公司|集团|总裁|董事长|上司|下属|职场|项目|助理/])
        ? "职场婚恋"
        : hasAny(source, [/豪门|总裁|千金|继承人/])
          ? "豪门总裁"
          : "都市情感";
    }

    const tagRules = [
      ["婚恋纠葛", /离婚|前夫|前妻|婚姻|复婚|假离婚/],
      ["职场", /公司|集团|上司|下属|职场|项目|助理|总监/],
      ["复仇逆袭", /复仇|反杀|清算|逆袭|打脸|渣男|陷阱/],
      ["豪门", /豪门|总裁|董事长|千金|继承人/],
      ["久别重逢", /久别重逢|多年后|三年后|五年后|再次见到|重逢/],
      ["破镜重圆", /破镜重圆|复婚|重新开始|追回|追妻/],
      ["重生", /重生|前世|上一世/],
      ["穿越", /穿越|穿书|异世/],
      ["系统", /系统|签到|任务奖励/],
      ["悬疑", /凶手|命案|尸体|破案|刑警|侦探|谜案/],
    ];
    const tags = tagRules
      .filter(([, expression]) => expression.test(source))
      .map(([tag]) => tag)
      .slice(0, 4);
    if (!tags.length) tags.push(primary === "都市" ? "都市生活" : secondary);

    return {
      audience,
      primary,
      secondary,
      tags,
      text: `${audience}｜${primary} > ${secondary}｜标签：${tags.join("、")}`,
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
    if (fields.platform !== "qimao" || fields.mode !== "work-info" || !fields.title || !fields.summary) {
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
    if (fields.mode !== "short-story" || !fields.title || !fields.body) {
      return {
        ok: false,
        mode: fields.mode,
        titleFound: Boolean(fields.title),
        bodyFound: Boolean(fields.body),
      };
    }
    const title = String(story?.title || "").trim();
    const body = fullStoryBody(story);
    if (fields.combinedEditor) {
      setEditableHtml(fields.body, `<h1>${escapeHtml(title)}</h1>${bodyToHtml(body)}`);
    } else {
      fillTitleElement(fields.title, title);
      fillElement(fields.body, body);
    }
    return {
      ok: true,
      mode: "short-story",
      titleFound: true,
      bodyFound: true,
      combinedEditor: fields.combinedEditor,
    };
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
      .actions { margin-top: 12px; display: grid; grid-template-columns: 40px minmax(0, 1fr) 40px; gap: 7px; }
      .actions button, .refresh { min-height: 40px; border: 1px solid #143f36; border-radius: 5px; background: #143f36; color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .actions .step { padding: 0; background: #fff; color: #143f36; font-size: 18px; }
      .panel.whole-story .chapter-row, .panel.whole-story .step { display: none; }
      .panel.whole-story .actions { grid-template-columns: minmax(0, 1fr); }
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
        <div class="meta"><span class="position"></span><span class="characters"></span></div>
        <div class="type-suggestion"><span>建议作品类型</span><strong class="suggestion"></strong><small>根据标题和正文粗略判断，请在七猫选择最接近的选项。</small></div>
        <div class="protagonist-suggestion"><span>建议主角名</span><strong class="protagonists"></strong><small>根据正文中的姓名出现频率提取，请核对后使用。</small></div>
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

  async function saveState(extra = {}) {
    if (!globalThis.chrome?.storage?.local) return;
    await chrome.storage.local.set({
      storyId: state.activeStory?.id || "",
      chapterIndex: state.activeChapterIndex,
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
      Boolean(fields.body),
      Boolean(fields.combinedEditor),
    ].join(":");
  }

  function showDetectionStatus(fields) {
    if (fields.mode === "work-info") {
      updateStatus(
        `已进入七猫作品信息模式。作品名称框${fields.title ? "已识别" : "未识别"}，简介框${fields.summary ? "已识别" : "未识别"}，主角名框识别到 ${fields.protagonists.length} 个。`,
        fields.title && fields.summary ? "success" : "error",
      );
      return;
    }
    if (fields.mode === "short-story") {
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
    renderChapterMeta();
    renderWorkTypeSuggestion();
  }

  function renderChapterMeta() {
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
    ui.position.textContent = `${state.activeChapterIndex + 1} / ${state.activeStory.chapters.length}`;
    ui.characters.textContent = `${chapter.characters.toLocaleString("zh-CN")} 字`;
    ui.previous.disabled = state.activeChapterIndex === 0;
    ui.next.disabled = state.activeChapterIndex === state.activeStory.chapters.length - 1;
  }

  function renderWorkTypeSuggestion() {
    if (!ui?.suggestion || !state.activeStory) return;
    ui.suggestion.textContent = suggestWorkType(state.activeStory).text;
    const protagonists = suggestProtagonists(state.activeStory);
    ui.protagonists.textContent = protagonists.length ? protagonists.join("、") : "未识别到明确人名，请手动填写";
  }

  function setEditorMode(mode) {
    const platformName = state.fields.platform === "qimao" ? "七猫" : "番茄";
    const wholeStory = mode === "short-story" || mode === "work-info";
    ui.panel.classList.toggle("whole-story", wholeStory);
    ui.panel.classList.toggle("work-info", mode === "work-info");
    ui.panel.classList.toggle("short-story", mode === "short-story");
    ui.mode.textContent = mode === "work-info"
      ? `${platformName} · 作品信息`
      : mode === "short-story"
        ? `${platformName} · 短故事`
        : `${platformName} · 章节`;
    ui.fill.textContent = mode === "work-info"
      ? "填入作品信息"
      : mode === "short-story"
        ? "填入整篇短故事"
        : "填入当前章节";
    renderChapterMeta();
    renderWorkTypeSuggestion();
  }

  function selectStory(storyId) {
    state.activeStory = state.stories.find((story) => story.id === storyId) || state.stories[0];
    state.activeChapterIndex = 0;
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
      position: shadow.querySelector(".position"),
      characters: shadow.querySelector(".characters"),
      suggestion: shadow.querySelector(".suggestion"),
      protagonists: shadow.querySelector(".protagonists"),
      status: shadow.querySelector(".status"),
      previous: shadow.querySelector(".previous"),
      next: shadow.querySelector(".next"),
      fill: shadow.querySelector(".fill"),
      refresh: shadow.querySelector(".refresh"),
    };

    ui.story.addEventListener("change", () => selectStory(ui.story.value));
    ui.chapter.addEventListener("change", () => selectChapter(ui.chapter.value));
    ui.previous.addEventListener("click", () => selectChapter(state.activeChapterIndex - 1));
    ui.next.addEventListener("click", () => selectChapter(state.activeChapterIndex + 1));
    ui.refresh.addEventListener("click", loadLibrary);
    ui.fill.addEventListener("click", () => {
      const fields = detectEditorFields();
      setEditorMode(fields.mode);
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
              ? `作品名称超过七猫 18 字限制，已截短；简介草稿已填入。${protagonistMessage}`
              : `作品名称和简介草稿已填入。${protagonistMessage} 请补充分类、标签等信息后再确认创建。`,
            result.titleTruncated ? "error" : "success",
          );
        } else {
          const missing = [!result.titleFound && "作品名称框", !result.summaryFound && "简介框"].filter(Boolean).join("、");
          updateStatus(`未识别${missing}。请打开七猫“新建小说”的作品信息页后重新检测。`, "error");
        }
        return;
      }
      if (fields.mode === "short-story") {
        const result = fillShortStory(state.activeStory);
        if (result.ok) {
          updateStatus("短故事名称和整篇正文已填入，请核对后在番茄后台保存或进入下一步。", "success");
        } else {
          const missing = [!result.titleFound && "故事名称框", !result.bodyFound && "正文框"].filter(Boolean).join("、");
          updateStatus(`未识别${missing}。请打开短故事编辑页后重新检测。`, "error");
        }
        return;
      }
      const chapter = currentChapter();
      if (!chapter) return;
      const result = fillEditor(chapter.title, chapter.body, state.activeChapterIndex + 1);
      if (result.ok) {
        if (fields.platform === "qimao") {
          updateStatus("七猫章节标题和正文已填入，请核对后手动保存或发布。", "success");
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
    fillShortStory,
    fillWorkInfo,
    fullStoryBody,
    normalizeFanqieTitle,
    parseChapterTitle,
    storySynopsis,
    suggestProtagonists,
    suggestWorkType,
  };
  globalThis.__readerPublisherImporter = globalThis.__readerFanqieImporter;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
  } else {
    mountPanel();
  }
})();
