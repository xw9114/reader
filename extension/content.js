(() => {
  const ROOT_ID = "reader-fanqie-importer";
  const STORAGE_DEFAULTS = { storyId: "", chapterIndex: 0, collapsed: false };
  const state = {
    stories: [],
    activeStory: null,
    activeChapterIndex: 0,
    fields: { title: null, body: null },
  };

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
    let score = 0;
    if (/章节标题|章节名|标题|chapter.?title/.test(text)) score += 12;
    if (/请输入.*标题|title/.test(text)) score += 5;
    if (/搜索|search|简介|书名/.test(text)) score -= 14;
    if (element instanceof HTMLInputElement) score += 3;
    if (element.maxLength > 0 && element.maxLength <= 100) score += 3;
    return score;
  }

  function bodyScore(element) {
    const text = fieldText(element);
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (/正文|章节内容|内容|请输入正文|content|editor/.test(text)) score += 10;
    if (/简介|搜索|标题|书名/.test(text)) score -= 12;
    if (element.isContentEditable) score += 6;
    if (rect.height >= 180) score += 5;
    if (rect.width >= 500) score += 3;
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
    const title = bestCandidate(
      "input:not([type]), input[type='text'], textarea",
      titleScore,
    );
    const body = bestCandidate(
      "[contenteditable='true'], textarea, [role='textbox']",
      bodyScore,
      title,
    );
    state.fields = { title, body };
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

  function setEditableValue(element, value) {
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, value);
    if (!inserted || element.textContent.trim() !== value.trim()) {
      element.textContent = value;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillElement(element, value) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setInputValue(element, value);
      return;
    }
    setEditableValue(element, value);
  }

  function fillEditor(title, body) {
    const fields = detectEditorFields();
    if (!fields.title || !fields.body) {
      return { ok: false, titleFound: Boolean(fields.title), bodyFound: Boolean(fields.body) };
    }
    fillElement(fields.title, title);
    fillElement(fields.body, body);
    return { ok: true, titleFound: true, bodyFound: true };
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
      select { width: 100%; min-height: 40px; margin-top: 5px; padding: 0 34px 0 10px; border: 1px solid #cad4d0; border-radius: 5px; background: #fff; color: #17201d; font: inherit; font-size: 13px; }
      .status { margin: 12px 0 0; padding: 9px 10px; border-left: 3px solid #e75b3f; background: #fff; color: #4c5b56; font-size: 12px; line-height: 1.5; }
      .actions { margin-top: 12px; display: grid; grid-template-columns: 40px minmax(0, 1fr) 40px; gap: 7px; }
      .actions button, .refresh { min-height: 40px; border: 1px solid #143f36; border-radius: 5px; background: #143f36; color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .actions .step { padding: 0; background: #fff; color: #143f36; font-size: 18px; }
      .refresh { width: 100%; margin-top: 8px; border-color: #cad4d0; background: #fff; color: #143f36; font-size: 12px; }
      button:disabled { opacity: .45; cursor: not-allowed; }
      .meta { margin-top: 8px; display: flex; justify-content: space-between; color: #71807b; font-size: 11px; }
      @media (max-width: 700px) { .panel { width: min(340px, calc(100vw - 24px)); } }
    </style>
    <section class="panel">
      <header class="header"><strong>番茄导入助手</strong><button class="collapse" type="button" aria-label="收起面板">−</button></header>
      <div class="body">
        <label>作品<select class="story"></select></label>
        <label>章节<select class="chapter"></select></label>
        <div class="meta"><span class="position"></span><span class="characters"></span></div>
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
  }

  function renderChapterMeta() {
    const chapter = currentChapter();
    if (!chapter) return;
    ui.position.textContent = `${state.activeChapterIndex + 1} / ${state.activeStory.chapters.length}`;
    ui.characters.textContent = `${chapter.characters.toLocaleString("zh-CN")} 字`;
    ui.previous.disabled = state.activeChapterIndex === 0;
    ui.next.disabled = state.activeChapterIndex === state.activeStory.chapters.length - 1;
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
    updateStatus(
      `已读取 ${state.stories.length} 篇作品。标题框${fields.title ? "已识别" : "未识别"}，正文框${fields.body ? "已识别" : "未识别"}。`,
      fields.title && fields.body ? "success" : "error",
    );
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
      story: shadow.querySelector(".story"),
      chapter: shadow.querySelector(".chapter"),
      position: shadow.querySelector(".position"),
      characters: shadow.querySelector(".characters"),
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
      const chapter = currentChapter();
      if (!chapter) return;
      const result = fillEditor(chapter.title, chapter.body);
      if (result.ok) {
        updateStatus("标题和正文已填入，请核对后在番茄后台保存或发布。", "success");
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
    loadLibrary();
  }

  globalThis.__readerFanqieImporter = { detectEditorFields, fillEditor };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
  } else {
    mountPanel();
  }
})();
