const state = {
  stories: [],
  activeStory: null,
  activeChapterIndex: 0,
  query: "",
};

const elements = {
  libraryStatus: document.querySelector("#libraryStatus"),
  storySearch: document.querySelector("#storySearch"),
  storyList: document.querySelector("#storyList"),
  editor: document.querySelector("#editor"),
  emptyState: document.querySelector("#emptyState"),
  storyDate: document.querySelector("#storyDate"),
  storyTitle: document.querySelector("#storyTitle"),
  extensionDownload: document.querySelector("#extensionDownload"),
  downloadStory: document.querySelector("#downloadStory"),
  downloadMarkdown: document.querySelector("#downloadMarkdown"),
  downloadZip: document.querySelector("#downloadZip"),
  chapterSelect: document.querySelector("#chapterSelect"),
  previousChapter: document.querySelector("#previousChapter"),
  nextChapter: document.querySelector("#nextChapter"),
  chapterPosition: document.querySelector("#chapterPosition"),
  characterCount: document.querySelector("#characterCount"),
  chapterTitle: document.querySelector("#chapterTitle"),
  chapterBody: document.querySelector("#chapterBody"),
  actionBar: document.querySelector("#actionBar"),
  copyTitle: document.querySelector("#copyTitle"),
  copyBody: document.querySelector("#copyBody"),
  copyAll: document.querySelector("#copyAll"),
  toast: document.querySelector("#toast"),
};

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function filteredStories() {
  const query = state.query.trim().toLowerCase();
  if (!query) return state.stories;
  return state.stories.filter((story) =>
    `${story.title} ${story.date}`.toLowerCase().includes(query),
  );
}

function renderStoryList() {
  elements.storyList.replaceChildren();
  const stories = filteredStories();

  if (!stories.length) {
    const message = document.createElement("p");
    message.className = "library-status";
    message.textContent = "没有匹配的作品";
    elements.storyList.append(message);
    return;
  }

  stories.forEach((story) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `story-item${story.id === state.activeStory?.id ? " active" : ""}`;
    button.dataset.storyId = story.id;

    const title = document.createElement("span");
    title.className = "story-item-title";
    title.textContent = story.title;

    const meta = document.createElement("span");
    meta.className = "story-item-meta";
    meta.innerHTML = `<span>${story.date || "未标日期"}</span><span>${story.chapters.length} 节</span>`;

    button.append(title, meta);
    button.addEventListener("click", () => selectStory(story.id));
    elements.storyList.append(button);
  });
}

function selectStory(storyId, chapterIndex = 0) {
  const story = state.stories.find((item) => item.id === storyId);
  if (!story) return;

  state.activeStory = story;
  state.activeChapterIndex = Math.min(Math.max(chapterIndex, 0), story.chapters.length - 1);
  localStorage.setItem("reader:lastStory", storyId);
  renderStoryList();
  renderEditor();

  document.querySelector(`[data-story-id="${CSS.escape(storyId)}"]`)?.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
    inline: "nearest",
  });
}

function selectChapter(index) {
  if (!state.activeStory) return;
  state.activeChapterIndex = Math.min(
    Math.max(Number(index), 0),
    state.activeStory.chapters.length - 1,
  );
  renderChapter();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderEditor() {
  const story = state.activeStory;
  if (!story) return;

  elements.emptyState.hidden = true;
  elements.editor.hidden = false;
  elements.actionBar.hidden = false;
  elements.storyDate.textContent = story.date || "未标日期";
  elements.storyTitle.textContent = story.title;
  const downloads = story.downloads || { txt: story.download };
  elements.downloadStory.href = downloads.txt;
  elements.downloadStory.download = `${story.title}.txt`;
  elements.downloadMarkdown.href = downloads.md || story.source;
  elements.downloadMarkdown.download = `${story.title}.md`;
  elements.downloadZip.href = downloads.zip || downloads.txt;
  elements.downloadZip.download = `${story.title}-逐章.zip`;
  elements.chapterSelect.replaceChildren();

  story.chapters.forEach((chapter, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = chapter.title;
    elements.chapterSelect.append(option);
  });

  renderChapter();
}

function renderChapter() {
  const story = state.activeStory;
  const chapter = story?.chapters[state.activeChapterIndex];
  if (!story || !chapter) return;

  elements.chapterSelect.value = String(state.activeChapterIndex);
  elements.chapterTitle.textContent = chapter.title;
  elements.chapterBody.textContent = chapter.body || "（本节暂无正文）";
  elements.chapterPosition.textContent = `${state.activeChapterIndex + 1} / ${story.chapters.length}`;
  elements.characterCount.textContent = `${formatNumber(chapter.characters)} 字`;
  elements.previousChapter.disabled = state.activeChapterIndex === 0;
  elements.nextChapter.disabled = state.activeChapterIndex === story.chapters.length - 1;
}

async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy failed");
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 1800);
}

async function copyCurrent(kind) {
  const chapter = state.activeStory?.chapters[state.activeChapterIndex];
  if (!chapter) return;

  const values = {
    title: chapter.title,
    body: chapter.body,
    all: `${chapter.title}\n\n${chapter.body}`,
  };
  const messages = {
    title: "章节标题已复制",
    body: "章节正文已复制",
    all: "标题和正文已复制",
  };

  try {
    await writeClipboard(values[kind]);
    showToast(messages[kind]);
  } catch {
    showToast("复制失败，请长按正文选择复制");
  }
}

elements.storySearch.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderStoryList();
});
elements.chapterSelect.addEventListener("change", (event) => selectChapter(event.target.value));
elements.previousChapter.addEventListener("click", () => selectChapter(state.activeChapterIndex - 1));
elements.nextChapter.addEventListener("click", () => selectChapter(state.activeChapterIndex + 1));
elements.copyTitle.addEventListener("click", () => copyCurrent("title"));
elements.copyBody.addEventListener("click", () => copyCurrent("body"));
elements.copyAll.addEventListener("click", () => copyCurrent("all"));

async function initialize() {
  try {
    const response = await fetch("data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.stories = data.stories;
    if (data.extensionDownload) {
      elements.extensionDownload.href = data.extensionDownload;
    }
    elements.libraryStatus.textContent = `${data.storyCount} 篇作品`;

    const remembered = localStorage.getItem("reader:lastStory");
    const initialId = state.stories.some((story) => story.id === remembered)
      ? remembered
      : data.latestStoryId;
    selectStory(initialId);
  } catch (error) {
    elements.libraryStatus.textContent = "稿件读取失败";
    elements.emptyState.innerHTML = `<p>无法读取作品数据，请稍后刷新。</p>`;
    console.error(error);
  }
}

initialize();
