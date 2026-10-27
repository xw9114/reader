function text(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function list(...values) {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const items = [...new Set(value.filter((item) => typeof item === "string")
      .map((item) => item.trim()).filter(Boolean))];
    if (items.length) return items;
  }
  return [];
}

function resolveCreateMetadata(book, override = {}) {
  const hint = book.publishingHint || {};
  return {
    protagonist: text(override.protagonist, book.protagonist),
    synopsis: text(override.synopsis, book.synopsis, book.summary, book.description),
    audience: text(override.audience, book.audience, hint.audience),
    categories: list(override.categories, book.categories, hint.readingTags),
    tags: list(override.tags, book.tags, hint.contentTags),
  };
}

function missingCreateFields(metadata) {
  const missing = [];
  if (!metadata.protagonist) missing.push("主角名");
  if (!metadata.synopsis) missing.push("简介");
  if (!["男频", "女频"].includes(metadata.audience)) missing.push("频道");
  if (!metadata.categories.length) missing.push("主分类");
  if (!metadata.tags.length) missing.push("标签");
  return missing;
}

module.exports = { resolveCreateMetadata, missingCreateFields };
