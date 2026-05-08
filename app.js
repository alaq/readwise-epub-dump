const elements = {
  form: document.querySelector("#controls"),
  token: document.querySelector("#token"),
  showToken: document.querySelector("#showToken"),
  rememberToken: document.querySelector("#rememberToken"),
  tokenHint: document.querySelector("#tokenHint"),
  location: document.querySelector("#location"),
  tagPrefix: document.querySelector("#tagPrefix"),
  applyTags: document.querySelector("#applyTags"),
  archive: document.querySelector("#archive"),
  run: document.querySelector("#run"),
  cancel: document.querySelector("#cancel"),
  status: document.querySelector("#status"),
  log: document.querySelector("#log"),
  download: document.querySelector("#download"),
  downloadLog: document.querySelector("#downloadLog"),
  tagPreview: document.querySelector("#tagPreview"),
  tagHint: document.querySelector("#tagHint"),
  filterFrom: document.querySelector("#filterFrom"),
  filterTo: document.querySelector("#filterTo"),
  filterTag: document.querySelector("#filterTag"),
  filterHtml: document.querySelector("#filterHtml"),
  epubTitle: document.querySelector("#epubTitle"),
  epubAuthor: document.querySelector("#epubAuthor"),
  epubCover: document.querySelector("#epubCover"),
  generateCover: document.querySelector("#generateCover"),
  aiCoverFields: document.querySelector("#aiCoverFields"),
  openaiKey: document.querySelector("#openaiKey"),
  showOpenaiKey: document.querySelector("#showOpenaiKey"),
  coverQuality: document.querySelector("#coverQuality"),
  progressFetched: document.querySelector("#progressFetched"),
  progressSelected: document.querySelector("#progressSelected"),
  progressBuilt: document.querySelector("#progressBuilt"),
  progressUpdated: document.querySelector("#progressUpdated"),
  progressFailed: document.querySelector("#progressFailed"),
};

const READWISE_API = "https://readwise.io/api/v3";
const OPENAI_IMAGES_API = "https://api.openai.com/v1/images/generations";
const OPENAI_COVER_MODEL = "gpt-image-2";
const RATE_LIMIT_MS = 3000;
const TOKEN_STORAGE_KEY = "readwise-epub-dump.token";
const SETTINGS_STORAGE_KEY = "readwise-epub-dump.settings";
const DEFAULT_TITLE = "Readwise Export";
const DEFAULT_AUTHOR = "Readwise";
const COVER_CONTEXT_MAX_CHARS = 6000;
const COVER_SAMPLE_ITEM_LIMIT = 12;
const COVER_EXCERPT_MAX_CHARS = 320;

const progressState = {
  fetched: 0,
  selected: 0,
  built: 0,
  updated: 0,
  failed: 0,
};

let runState = null;

function setStatus(message) {
  elements.status.textContent = message;
}

function logLine(message) {
  elements.log.textContent += `${message}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function clearLog() {
  elements.log.textContent = "";
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Canceled."));
      return;
    }
    const timeout = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Canceled."));
    }

    if (signal) {
      signal.addEventListener("abort", onAbort);
    }
  });
}

function assertNotCanceled(signal) {
  if (signal?.aborted) {
    throw new Error("Canceled.");
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function makeUuid() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const rand = Math.random() * 16;
    const value = char === "x" ? rand : (rand % 4) + 8;
    return Math.floor(value).toString(16);
  });
}

function normalizeToken(value) {
  return value.trim().replace(/^Token\s+/i, "");
}

function updateTokenHint() {
  const raw = elements.token.value.trim();
  if (!raw) {
    elements.tokenHint.textContent = "";
    return;
  }
  if (/^Token\s+/i.test(raw)) {
    elements.tokenHint.textContent =
      "Paste only the token value (omit the \"Token \" prefix).";
    return;
  }
  if (raw.length < 20) {
    elements.tokenHint.textContent = "Token looks short. Double-check the value.";
    return;
  }
  elements.tokenHint.textContent = "";
}

function updateTagHint(prefix) {
  if (!prefix) {
    elements.tagHint.textContent = "";
    return;
  }
  if (/\s/.test(prefix)) {
    elements.tagHint.textContent = "Avoid spaces in tag prefixes.";
    return;
  }
  if (!/^[a-z0-9_-]+$/i.test(prefix)) {
    elements.tagHint.textContent = "Use only letters, numbers, dashes, or underscores.";
    return;
  }
  elements.tagHint.textContent = "";
}

function renderProgress() {
  elements.progressFetched.textContent = progressState.fetched;
  elements.progressSelected.textContent = progressState.selected;
  elements.progressBuilt.textContent = progressState.built;
  elements.progressUpdated.textContent = progressState.updated;
  elements.progressFailed.textContent = progressState.failed;
}

function setProgress(next) {
  Object.assign(progressState, next);
  renderProgress();
}

function resetProgress() {
  setProgress({ fetched: 0, selected: 0, built: 0, updated: 0, failed: 0 });
}

function loadStoredToken() {
  if (!elements.rememberToken.checked) {
    return;
  }
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) {
      elements.token.value = stored;
    }
  } catch (error) {
    // Ignore storage errors (private mode, blocked storage, etc.).
  }
}

function storeToken(value) {
  if (!elements.rememberToken.checked) {
    return;
  }
  try {
    if (!value) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      return;
    }
    localStorage.setItem(TOKEN_STORAGE_KEY, value);
  } catch (error) {
    // Ignore storage errors (private mode, blocked storage, etc.).
  }
}

function getSettingsFromForm() {
  return {
    location: elements.location.value,
    tagPrefix: elements.tagPrefix.value.trim(),
    applyTags: elements.applyTags.checked,
    archive: elements.archive.checked,
    rememberToken: elements.rememberToken.checked,
    filters: {
      from: elements.filterFrom.value,
      to: elements.filterTo.value,
      tag: elements.filterTag.value.trim(),
      onlyHtml: elements.filterHtml.checked,
    },
    metadata: {
      title: elements.epubTitle.value.trim(),
      author: elements.epubAuthor.value.trim(),
    },
    cover: {
      generate: elements.generateCover.checked,
      quality: elements.coverQuality.value,
    },
  };
}

function saveSettings() {
  try {
    const settings = getSettingsFromForm();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    // Ignore storage errors (private mode, blocked storage, etc.).
  }
}

function applySettings(settings) {
  if (!settings || typeof settings !== "object") {
    return;
  }
  if (settings.location) {
    elements.location.value = settings.location;
  }
  if (typeof settings.tagPrefix === "string") {
    elements.tagPrefix.value = settings.tagPrefix;
  }
  if (typeof settings.applyTags === "boolean") {
    elements.applyTags.checked = settings.applyTags;
  }
  if (typeof settings.archive === "boolean") {
    elements.archive.checked = settings.archive;
  }
  if (typeof settings.rememberToken === "boolean") {
    elements.rememberToken.checked = settings.rememberToken;
  }
  if (settings.filters && typeof settings.filters === "object") {
    if (typeof settings.filters.from === "string") {
      elements.filterFrom.value = settings.filters.from;
    }
    if (typeof settings.filters.to === "string") {
      elements.filterTo.value = settings.filters.to;
    }
    if (typeof settings.filters.tag === "string") {
      elements.filterTag.value = settings.filters.tag;
    }
    if (typeof settings.filters.onlyHtml === "boolean") {
      elements.filterHtml.checked = settings.filters.onlyHtml;
    }
  }
  if (settings.metadata && typeof settings.metadata === "object") {
    if (typeof settings.metadata.title === "string") {
      elements.epubTitle.value = settings.metadata.title;
    }
    if (typeof settings.metadata.author === "string") {
      elements.epubAuthor.value = settings.metadata.author;
    }
  }
  if (settings.cover && typeof settings.cover === "object") {
    if (typeof settings.cover.generate === "boolean") {
      elements.generateCover.checked = settings.cover.generate;
    }
    if (typeof settings.cover.quality === "string") {
      elements.coverQuality.value = settings.cover.quality;
    }
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const settings = JSON.parse(raw);
    applySettings(settings);
  } catch (error) {
    // Ignore storage errors (private mode, blocked storage, etc.).
  }
}

function updateTagPreview() {
  const prefix = elements.tagPrefix.value.trim();
  if (!prefix) {
    elements.tagPreview.textContent = "(set a tag prefix)";
    updateTagHint("");
    return;
  }
  elements.tagPreview.textContent = `${prefix}-${todayUtc()}`;
  updateTagHint(prefix);
}

function updateCoverControls() {
  const enabled = elements.generateCover.checked;
  elements.aiCoverFields.hidden = !enabled;
  elements.openaiKey.disabled = !enabled;
  elements.showOpenaiKey.disabled = !enabled;
  elements.coverQuality.disabled = !enabled;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const DROP_ELEMENTS = new Set(["script", "noscript"]);

function parseHtmlContent(html) {
  if (!html) {
    return null;
  }
  const lower = html.toLowerCase();
  const parser = new DOMParser();
  if (lower.includes("<html") || lower.includes("<body")) {
    return parser.parseFromString(html, "text/html");
  }
  return parser.parseFromString(`<body>${html}</body>`, "text/html");
}

function serializeNode(node) {
  switch (node.nodeType) {
    case Node.TEXT_NODE:
      return escapeXml(node.nodeValue || "");
    case Node.ELEMENT_NODE: {
      const tag = node.tagName.toLowerCase();
      if (DROP_ELEMENTS.has(tag)) {
        return "";
      }
      let attrs = "";
      for (const attr of node.attributes) {
        attrs += ` ${attr.name}=\"${escapeXml(attr.value)}\"`;
      }
      if (VOID_ELEMENTS.has(tag)) {
        return `<${tag}${attrs} />`;
      }
      const children = Array.from(node.childNodes)
        .map(serializeNode)
        .join("");
      return `<${tag}${attrs}>${children}</${tag}>`;
    }
    default:
      return "";
  }
}

function serializeChildren(node) {
  return Array.from(node.childNodes).map(serializeNode).join("");
}

function resolveUrl(source, baseUrl) {
  if (!source) {
    return null;
  }
  if (!baseUrl) {
    try {
      return new URL(source).toString();
    } catch (error) {
      return null;
    }
  }
  try {
    return new URL(source, baseUrl).toString();
  } catch (error) {
    return null;
  }
}

function inferImageExtension(mediaType, sourceUrl) {
  if (mediaType) {
    const normalized = mediaType.split(";")[0].trim();
    const known = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "image/avif": "avif",
    };
    if (known[normalized]) {
      return known[normalized];
    }
  }

  if (sourceUrl) {
    const match = sourceUrl.split("?")[0].match(/\\.([a-z0-9]+)$/i);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return "bin";
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]*)(;base64)?,(.*)$/);
  if (!match) {
    return null;
  }
  const mediaType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const dataPart = match[3] || "";
  try {
    if (isBase64) {
      return { mediaType, bytes: base64ToBytes(dataPart) };
    }
    const decoded = decodeURIComponent(dataPart);
    const bytes = new TextEncoder().encode(decoded);
    return { mediaType, bytes };
  } catch (error) {
    return null;
  }
}

async function fetchImageBytes(url, signal) {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("Content-Type") || "";
    const buffer = await response.arrayBuffer();
    return { contentType, bytes: new Uint8Array(buffer) };
  } catch (error) {
    return null;
  }
}

function registerImageAsset(registry, key, mediaType, bytes, sourceUrl) {
  if (registry.map.has(key)) {
    return registry.map.get(key);
  }

  registry.counter += 1;
  const extension = inferImageExtension(mediaType, sourceUrl);
  const filename = `image-${registry.counter}.${extension}`;
  const asset = {
    id: `image-${registry.counter}`,
    href: `images/${filename}`,
    filename,
    mediaType: mediaType.split(";")[0].trim() || "application/octet-stream",
    bytes,
  };
  registry.map.set(key, asset);
  return asset;
}

async function embedImagesInDocument(doc, baseUrl, registry, options = {}) {
  const images = Array.from(doc.querySelectorAll("img"));
  let inlined = 0;
  let failed = 0;
  let skipped = 0;

  for (const img of images) {
    assertNotCanceled(options.signal);
    const src =
      img.getAttribute("src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original");
    if (!src) {
      skipped += 1;
      continue;
    }

    let asset = null;
    if (src.startsWith("data:")) {
      const parsed = parseDataUrl(src);
      if (parsed) {
        asset = registerImageAsset(
          registry,
          src,
          parsed.mediaType,
          parsed.bytes,
          null
        );
      }
    } else {
      const resolved = resolveUrl(src, baseUrl);
      if (!resolved) {
        failed += 1;
        continue;
      }
      asset = registry.map.get(resolved);
      if (!asset) {
        const fetched = await fetchImageBytes(resolved, options.signal);
        if (!fetched) {
          img.setAttribute("src", resolved);
          failed += 1;
          continue;
        }
        asset = registerImageAsset(
          registry,
          resolved,
          fetched.contentType,
          fetched.bytes,
          resolved
        );
      }
    }

    if (!asset) {
      failed += 1;
      continue;
    }

    img.setAttribute("src", `../${asset.href}`);
    img.removeAttribute("srcset");
    img.removeAttribute("data-src");
    img.removeAttribute("data-original");
    inlined += 1;
  }

  return { total: images.length, inlined, failed, skipped };
}

async function fetchAllDocuments(token, location, options = {}) {
  let cursor = null;
  const items = [];
  let expectedCount = null;

  do {
    assertNotCanceled(options.signal);
    const params = new URLSearchParams();
    params.set("withHtmlContent", "true");
    if (location) {
      params.set("location", location);
    }
    if (cursor) {
      params.set("pageCursor", cursor);
    }

    const response = await fetchWithRetry(
      `${READWISE_API}/list/?${params.toString()}`,
      {
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json",
        },
        signal: options.signal,
      },
      { label: "Fetch articles" }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Fetch failed (${response.status}): ${body}`);
    }

    const data = await response.json();
    if (expectedCount === null) {
      expectedCount = data.count;
    }

    items.push(...data.results);
    logLine(`Fetched ${items.length}/${data.count} articles...`);
    options.onProgress?.({ fetched: items.length, total: data.count });

    cursor = data.nextPageCursor || null;
    if (cursor) {
      await sleep(RATE_LIMIT_MS, options.signal);
    }
  } while (cursor);

  return items;
}

function parseTagFilter(value) {
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function applyFilters(items, filters) {
  const tagNeedles = parseTagFilter(filters.tag || "");
  const from = filters.from || "";
  const to = filters.to || "";
  const onlyHtml = Boolean(filters.onlyHtml);
  const summary = {
    total: items.length,
    selected: 0,
    removedDate: 0,
    removedTag: 0,
    removedHtml: 0,
    missingDate: 0,
  };
  const selected = [];

  for (const item of items) {
    let include = true;
    const created = item.created_at ? item.created_at.slice(0, 10) : "";

    if ((from || to) && !created) {
      include = false;
      summary.missingDate += 1;
    }
    if (include && from && created < from) {
      include = false;
      summary.removedDate += 1;
    }
    if (include && to && created > to) {
      include = false;
      summary.removedDate += 1;
    }

    if (include && tagNeedles.length > 0) {
      const tags = Object.keys(item.tags || {}).map((tag) => tag.toLowerCase());
      const matches = tagNeedles.some((needle) =>
        tags.some((tag) => tag.includes(needle))
      );
      if (!matches) {
        include = false;
        summary.removedTag += 1;
      }
    }

    if (include && onlyHtml && !item.html_content) {
      include = false;
      summary.removedHtml += 1;
    }

    if (include) {
      selected.push(item);
    }
  }

  summary.selected = selected.length;
  return { items: selected, summary };
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value, maxChars) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const trimmed = normalized.slice(0, maxChars).replace(/\s+\S*$/, "");
  return `${trimmed}...`;
}

function htmlToText(html) {
  if (!html) {
    return "";
  }
  const doc = parseHtmlContent(html);
  return normalizeWhitespace(doc?.body?.textContent || "");
}

function getItemExcerpt(item) {
  const directExcerpt =
    item.summary || item.excerpt || item.description || item.notes || "";
  const text = directExcerpt || htmlToText(item.html_content || "");
  return truncateText(text, COVER_EXCERPT_MAX_CHARS);
}

function getItemTags(item) {
  return Object.keys(item.tags || {}).slice(0, 5).join(", ");
}

function selectRepresentativeItems(items, limit) {
  if (items.length <= limit) {
    return items;
  }

  const selected = [];
  const seen = new Set();
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round((index * (items.length - 1)) / (limit - 1));
    if (seen.has(sourceIndex)) {
      continue;
    }
    seen.add(sourceIndex);
    selected.push(items[sourceIndex]);
  }
  return selected;
}

function buildCoverContext(items, metadata) {
  const sampledItems = selectRepresentativeItems(items, COVER_SAMPLE_ITEM_LIMIT);
  const lines = [
    `EPUB title: ${metadata.title}`,
    `EPUB author: ${metadata.author}`,
    `Article count: ${items.length}`,
    `Sampled article context: ${sampledItems.length} representative items, each truncated.`,
  ];

  for (const [index, item] of sampledItems.entries()) {
    const title = normalizeWhitespace(item.title || `Untitled ${index + 1}`);
    const byline = [item.author, item.site_name].filter(Boolean).join(" / ");
    const tags = getItemTags(item);
    const excerpt = getItemExcerpt(item);
    const parts = [`${index + 1}. ${title}`];
    if (byline) {
      parts.push(`Source: ${normalizeWhitespace(byline)}`);
    }
    if (tags) {
      parts.push(`Tags: ${normalizeWhitespace(tags)}`);
    }
    if (excerpt) {
      parts.push(`Excerpt: ${excerpt}`);
    }
    lines.push(parts.join("\n"));

    if (lines.join("\n\n").length >= COVER_CONTEXT_MAX_CHARS) {
      break;
    }
  }

  return truncateText(lines.join("\n\n"), COVER_CONTEXT_MAX_CHARS);
}

function buildCoverPrompt(items, metadata) {
  const context = buildCoverContext(items, metadata);
  const prompt = `Create a portrait EPUB cover image inspired by this Readwise reading collection.

Design goals:
- Refined editorial book cover, suitable for an e-reader library thumbnail.
- Abstract or metaphorical composition inspired by the themes in the sampled context.
- Warm, serious, literary visual tone with strong contrast and a clear focal point.
- No screenshots, browser UI, article cards, watermarks, logos, author portraits, or collages of tiny text.
- Do not render readable words, letters, title text, or fake typography inside the image.

Use only this bounded, sampled context:
${context}`;

  return {
    prompt,
    contextLength: context.length,
    sampledCount: selectRepresentativeItems(items, COVER_SAMPLE_ITEM_LIMIT).length,
  };
}

async function readOpenAiError(response) {
  const body = await response.text();
  if (!body) {
    return `${response.status} ${response.statusText}`;
  }
  try {
    const parsed = JSON.parse(body);
    return parsed.error?.message || body;
  } catch (error) {
    return body;
  }
}

async function generateCoverAsset(apiKey, items, metadata, options = {}) {
  const promptData = buildCoverPrompt(items, metadata);
  logLine(
    `Generating cover with ${OPENAI_COVER_MODEL}: ${promptData.sampledCount}/${items.length} sampled articles, ${promptData.contextLength} context chars.`
  );

  const response = await fetchWithRetry(
    OPENAI_IMAGES_API,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_COVER_MODEL,
        prompt: promptData.prompt,
        n: 1,
        size: "1024x1536",
        quality: options.quality || "medium",
        output_format: "jpeg",
        background: "opaque",
        moderation: "auto",
      }),
      signal: options.signal,
    },
    { label: "Generate cover", retries: 2 }
  );

  if (!response.ok) {
    const message = await readOpenAiError(response);
    throw new Error(`Cover generation failed (${response.status}): ${message}`);
  }

  const data = await response.json();
  const image = data?.data?.[0];
  if (!image?.b64_json) {
    throw new Error("Cover generation succeeded but no image data was returned.");
  }

  return {
    filename: "cover.jpg",
    href: "images/cover.jpg",
    mediaType: "image/jpeg",
    bytes: base64ToBytes(image.b64_json),
  };
}

async function getCoverAsset(file) {
  if (!file) {
    return null;
  }
  const buffer = await file.arrayBuffer();
  const mediaType = file.type || "image/jpeg";
  const extension = inferImageExtension(mediaType, file.name);
  const filename = `cover.${extension}`;
  return {
    filename,
    href: `images/${filename}`,
    mediaType,
    bytes: new Uint8Array(buffer),
  };
}

function shouldRetryResponse(response) {
  if (!response) {
    return true;
  }
  if (response.status === 429) {
    return true;
  }
  return response.status >= 500 && response.status < 600;
}

function getRetryDelay(response, attempt) {
  const base = 800;
  const max = 6000;
  const jitter = Math.random() * 250;
  let delay = Math.min(max, base * 2 ** attempt) + jitter;
  if (response) {
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!Number.isNaN(seconds)) {
        delay = Math.max(delay, seconds * 1000);
      }
    }
  }
  return delay;
}

async function fetchWithRetry(url, options = {}, config = {}) {
  const retries = typeof config.retries === "number" ? config.retries : 3;
  const label = config.label || "Request";

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    assertNotCanceled(options.signal);
    try {
      const response = await fetch(url, options);
      if (!shouldRetryResponse(response) || attempt === retries) {
        return response;
      }
      const delay = getRetryDelay(response, attempt);
      logLine(`${label} retry ${attempt + 1}/${retries} in ${Math.round(delay)}ms.`);
      await sleep(delay, options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      if (attempt === retries) {
        throw error;
      }
      const delay = getRetryDelay(null, attempt);
      logLine(`${label} retry ${attempt + 1}/${retries} in ${Math.round(delay)}ms.`);
      await sleep(delay, options.signal);
    }
  }

  throw new Error("Request failed after retries.");
}

function buildContainerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`;
}

function buildNavXhtml(entries, title) {
  const list = entries
    .map(
      (entry) =>
        `      <li><a href="${entry.href}">${escapeXml(entry.title)}</a></li>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>${escapeXml(title)}</title>
    <meta charset="utf-8" />
    <link rel="stylesheet" type="text/css" href="styles.css" />
  </head>
  <body>
    <nav epub:type="toc">
      <h1>${escapeXml(title)}</h1>
      <ol>
${list}
      </ol>
    </nav>
  </body>
</html>`;
}

function buildTocNcx(entries, title, uid) {
  const navPoints = entries
    .map(
      (entry, index) => `    <navPoint id="navPoint-${index + 1}" playOrder="${
        index + 1
      }">
      <navLabel><text>${escapeXml(entry.title)}</text></navLabel>
      <content src="${entry.href}" />
    </navPoint>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uid}" />
    <meta name="dtb:depth" content="1" />
    <meta name="dtb:totalPageCount" content="0" />
    <meta name="dtb:maxPageNumber" content="0" />
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`;
}

function buildContentOpf(entries, imageItems, title, author, uid, coverItem) {
  const manifestItems = entries
    .map(
      (entry, index) =>
        `    <item id="item-${index + 1}" href="${entry.href}" media-type="application/xhtml+xml" />`
    )
    .join("\n");

  const imageManifestItems = imageItems
    .map(
      (item) => {
        const props = item.properties ? ` properties="${item.properties}"` : "";
        return `    <item id="${item.id}" href="${item.href}" media-type="${item.mediaType}"${props} />`;
      }
    )
    .join("\n");

  const spineItems = entries
    .map((_, index) => `    <itemref idref="item-${index + 1}" />`)
    .join("\n");

  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uid}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    ${coverItem ? `<meta name="cover" content="${coverItem.id}" />` : ""}
  </metadata>
  <manifest>
    <item id="css" href="styles.css" media-type="text/css" />
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
${manifestItems}
${imageManifestItems}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`;
}

async function buildChapterXhtml(item, imageRegistry, options = {}) {
  const title = item.title || "Untitled";
  const author = item.author || "";
  const site = item.site_name || "";
  const created = item.created_at ? item.created_at.slice(0, 10) : "";
  const source = item.source_url || item.url || "";

  let content = "";
  let imageStats = null;
  const doc = parseHtmlContent(item.html_content || "");
  if (doc && doc.body) {
    if (source) {
      imageStats = await embedImagesInDocument(doc, source, imageRegistry, {
        signal: options.signal,
      });
    }
    content = serializeChildren(doc.body);
  }

  if (!content) {
    content = `<p>Content unavailable from Readwise. <a href="${escapeXml(
      source
    )}">Open source</a>.</p>`;
  }

  if (imageStats && imageStats.total > 0) {
    logLine(
      `Images for ${title}: inlined ${imageStats.inlined}/${imageStats.total}, failed ${imageStats.failed}, skipped ${imageStats.skipped}.`
    );
  }

  const byline = [author, site].filter(Boolean).join(" - ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${escapeXml(title)}</title>
    <meta charset="utf-8" />
    <link rel="stylesheet" type="text/css" href="../styles.css" />
  </head>
  <body>
    <header>
      <h1>${escapeXml(title)}</h1>
      ${byline ? `<p class="byline">${escapeXml(byline)}</p>` : ""}
      ${created ? `<p class="meta">${escapeXml(created)}</p>` : ""}
      ${source ? `<p class="source"><a href="${escapeXml(source)}">${escapeXml(source)}</a></p>` : ""}
    </header>
    <article>
${content}
    </article>
  </body>
</html>`;
}

function buildCoverXhtml(title, coverHref) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${escapeXml(title)}</title>
    <meta charset="utf-8" />
    <link rel="stylesheet" type="text/css" href="../styles.css" />
  </head>
  <body class="cover">
    <img src="../${coverHref}" alt="Cover" />
  </body>
</html>`;
}

function buildStylesheet() {
  return `body {
  font-family: serif;
  line-height: 1.5;
  margin: 0;
  padding: 1.25rem 1.5rem 2rem;
}

h1 {
  font-size: 1.6rem;
  margin: 0 0 0.5rem;
}

.byline,
.meta,
.source {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
}

article img {
  max-width: 100%;
  height: auto;
}

.cover {
  margin: 0;
  padding: 0;
  text-align: center;
}

.cover img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}
`;
}

async function buildEpub(items, options) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  const containerXml = buildContainerXml();
  zip.folder("META-INF").file("container.xml", containerXml);

  const oebps = zip.folder("OEBPS");
  oebps.file("styles.css", buildStylesheet());

  const imageRegistry = { map: new Map(), counter: 0 };

  const entries = [];
  const coverEntry = options.cover
    ? { title: "Cover", href: "text/cover.xhtml" }
    : null;
  if (coverEntry) {
    entries.push(coverEntry);
  }
  items.forEach((item, index) => {
    entries.push({
      title: item.title || `Untitled ${index + 1}`,
      href: `text/item-${index + 1}.xhtml`,
    });
  });

  const textDir = oebps.folder("text");
  if (options.cover) {
    textDir.file("cover.xhtml", buildCoverXhtml(options.title, options.cover.href));
  }
  for (const [index, item] of items.entries()) {
    assertNotCanceled(options.signal);
    const chapter = await buildChapterXhtml(item, imageRegistry, {
      signal: options.signal,
    });
    textDir.file(`item-${index + 1}.xhtml`, chapter);
    options.onProgress?.({ built: index + 1, total: items.length });
  }

  const imageItems = [];
  const imagesDir = oebps.folder("images");
  let coverItem = null;
  if (options.cover) {
    imagesDir.file(options.cover.filename, options.cover.bytes);
    coverItem = {
      id: "cover-image",
      href: options.cover.href,
      mediaType: options.cover.mediaType,
      properties: "cover-image",
    };
    imageItems.push(coverItem);
  }
  if (imageRegistry.map.size > 0) {
    for (const asset of imageRegistry.map.values()) {
      imagesDir.file(asset.filename, asset.bytes);
      imageItems.push({
        id: asset.id,
        href: asset.href,
        mediaType: asset.mediaType,
      });
    }
  }

  oebps.file("nav.xhtml", buildNavXhtml(entries, options.title));
  oebps.file("toc.ncx", buildTocNcx(entries, options.title, options.uid));
  oebps.file(
    "content.opf",
    buildContentOpf(
      entries,
      imageItems,
      options.title,
      options.author,
      options.uid,
      coverItem
    )
  );

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

async function updateDocuments(items, token, options) {
  if (!options.applyTags && !options.archive) {
    logLine("Skipping tagging and archiving.");
    return { updated: 0, skipped: items.length, failed: 0, failedItems: [] };
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const failedItems = [];

  for (const item of items) {
    assertNotCanceled(options.signal);
    const payload = {};
    const tags = Object.keys(item.tags || {});

    if (options.applyTags && options.tag && !tags.includes(options.tag)) {
      payload.tags = [...tags, options.tag];
    }

    if (options.archive && item.location !== "archive") {
      payload.location = "archive";
    }

    if (Object.keys(payload).length === 0) {
      skipped += 1;
      continue;
    }

    const response = await fetchWithRetry(
      `${READWISE_API}/update/${item.id}/`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: options.signal,
      },
      { label: "Update article" }
    );

    if (response.ok) {
      updated += 1;
    } else {
      failed += 1;
      const body = await response.text();
      const label = item.title || item.id;
      failedItems.push(label);
      logLine(`Update failed for ${label}: ${response.status} ${body}`);
    }

    options.onProgress?.({ updated, failed });
    await sleep(RATE_LIMIT_MS, options.signal);
  }

  logLine(`Tag/archive updates: ${updated} updated, ${skipped} skipped, ${failed} failed.`);
  if (failedItems.length > 0) {
    const sample = failedItems.slice(0, 5).join(", ");
    const more = failedItems.length > 5 ? ` (+${failedItems.length - 5} more)` : "";
    logLine(`Update failures: ${sample}${more}.`);
  }

  return { updated, skipped, failed, failedItems };
}

function getTag(prefix) {
  if (!prefix) {
    return "";
  }
  return `${prefix}-${todayUtc()}`;
}

elements.tagPrefix.addEventListener("input", () => {
  updateTagPreview();
  saveSettings();
});
elements.location.addEventListener("change", saveSettings);
elements.applyTags.addEventListener("change", saveSettings);
elements.archive.addEventListener("change", saveSettings);
elements.filterFrom.addEventListener("change", saveSettings);
elements.filterTo.addEventListener("change", saveSettings);
elements.filterTag.addEventListener("input", saveSettings);
elements.filterHtml.addEventListener("change", saveSettings);
elements.epubTitle.addEventListener("input", saveSettings);
elements.epubAuthor.addEventListener("input", saveSettings);
elements.generateCover.addEventListener("change", () => {
  updateCoverControls();
  saveSettings();
});
elements.coverQuality.addEventListener("change", saveSettings);
elements.showOpenaiKey.addEventListener("change", () => {
  elements.openaiKey.type = elements.showOpenaiKey.checked ? "text" : "password";
});
elements.rememberToken.addEventListener("change", () => {
  if (!elements.rememberToken.checked) {
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (error) {
      // Ignore storage errors (private mode, blocked storage, etc.).
    }
  } else {
    storeToken(normalizeToken(elements.token.value));
  }
  saveSettings();
});
elements.showToken.addEventListener("change", () => {
  elements.token.type = elements.showToken.checked ? "text" : "password";
});
elements.token.addEventListener("input", () => {
  updateTokenHint();
  storeToken(normalizeToken(elements.token.value));
});

elements.downloadLog.addEventListener("click", () => {
  const content = elements.log.textContent.trim();
  if (!content) {
    setStatus("No logs to download yet.");
    return;
  }
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `readwise-epub-log-${todayUtc()}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

elements.cancel.addEventListener("click", () => {
  if (!runState) {
    return;
  }
  setStatus("Canceling...");
  runState.controller.abort();
});

loadSettings();
updateTagPreview();
updateCoverControls();
loadStoredToken();
updateTokenHint();
renderProgress();

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (runState) {
    return;
  }
  clearLog();
  resetProgress();
  setStatus("Starting...");
  elements.download.hidden = true;
  elements.run.disabled = true;
  elements.cancel.disabled = false;

  const controller = new AbortController();
  runState = { controller, downloadUrl: null };

  const token = normalizeToken(elements.token.value);
  elements.token.value = token;
  const location = elements.location.value;
  const tagPrefix = elements.tagPrefix.value.trim();
  const applyTags = elements.applyTags.checked;
  const archive = elements.archive.checked;
  const filters = {
    from: elements.filterFrom.value,
    to: elements.filterTo.value,
    tag: elements.filterTag.value.trim(),
    onlyHtml: elements.filterHtml.checked,
  };
  const metadataTitle = elements.epubTitle.value.trim();
  const metadataAuthor = elements.epubAuthor.value.trim();
  const generateCover = elements.generateCover.checked;
  const openaiKey = elements.openaiKey.value.trim();
  const coverQuality = elements.coverQuality.value;

  if (elements.rememberToken.checked) {
    storeToken(token);
  }
  saveSettings();

  if (!token) {
    setStatus("Access token is required.");
    elements.run.disabled = false;
    elements.cancel.disabled = true;
    runState = null;
    return;
  }
  if (generateCover && !openaiKey) {
    setStatus("OpenAI API key is required when generated covers are enabled.");
    elements.run.disabled = false;
    elements.cancel.disabled = true;
    runState = null;
    return;
  }

  const tag = getTag(tagPrefix);
  if (applyTags && !tag) {
    setStatus("Tag prefix is required when tagging is enabled.");
    elements.run.disabled = false;
    elements.cancel.disabled = true;
    runState = null;
    return;
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    setStatus("From date must be earlier than To date.");
    elements.run.disabled = false;
    elements.cancel.disabled = true;
    runState = null;
    return;
  }

  try {
    setStatus("Fetching articles...");
    const items = await fetchAllDocuments(token, location, {
      signal: controller.signal,
      onProgress: ({ fetched }) => setProgress({ fetched }),
    });
    setProgress({ fetched: items.length });

    const sorted = items
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const { items: filtered, summary } = applyFilters(sorted, filters);
    setProgress({ selected: summary.selected });

    logLine(`Filters: ${summary.selected}/${summary.total} articles selected.`);
    if (summary.removedDate > 0 || summary.missingDate > 0) {
      logLine(
        `Date filter removed ${summary.removedDate} items, ${summary.missingDate} missing dates.`
      );
    }
    if (summary.removedTag > 0) {
      logLine(`Tag filter removed ${summary.removedTag} items.`);
    }
    if (summary.removedHtml > 0) {
      logLine(`HTML filter removed ${summary.removedHtml} items.`);
    }

    const withHtml = filtered.filter((item) => item.html_content).length;
    logLine(`Readwise HTML available for ${withHtml}/${filtered.length} articles.`);

    for (const item of filtered) {
      const title = item.title || "Untitled";
      if (item.html_content) {
        logLine(`Using Readwise HTML for: ${title}`);
      } else {
        logLine(`Missing Readwise HTML for: ${title}`);
      }
    }

    assertNotCanceled(controller.signal);
    const title = metadataTitle || `${DEFAULT_TITLE} ${todayUtc()}`;
    const author = metadataAuthor || DEFAULT_AUTHOR;
    const uid = makeUuid();
    const coverFile = elements.epubCover.files[0] || null;
    let coverAsset = null;
    if (generateCover) {
      if (coverFile) {
        logLine("Generated cover enabled; uploaded cover file will be ignored.");
      }
      setStatus("Generating cover...");
      coverAsset = await generateCoverAsset(
        openaiKey,
        filtered,
        { title, author },
        {
          quality: coverQuality,
          signal: controller.signal,
        }
      );
      logLine("Generated cover image ready.");
    } else if (coverFile) {
      coverAsset = await getCoverAsset(coverFile);
    }

    setStatus("Building EPUB...");
    const epubBlob = await buildEpub(filtered, {
      title,
      author,
      uid,
      cover: coverAsset,
      signal: controller.signal,
      onProgress: ({ built }) => setProgress({ built }),
    });

    if (runState?.downloadUrl) {
      URL.revokeObjectURL(runState.downloadUrl);
    }
    const epubUrl = URL.createObjectURL(epubBlob);
    runState.downloadUrl = epubUrl;
    elements.download.href = epubUrl;
    elements.download.download = `readwise-${todayUtc()}.epub`;
    elements.download.hidden = false;

    setStatus("EPUB ready.");
    logLine("EPUB generated. You can download it now.");

    if (applyTags || archive) {
      setStatus("Applying tags/archive...");
      const tagValue = applyTags ? tag : "";
      if (applyTags) {
        logLine(`Tagging with: ${tagValue}`);
      }
      if (archive) {
        logLine("Archiving enabled.");
      }
      await updateDocuments(filtered, token, {
        applyTags,
        archive,
        tag: tagValue,
        signal: controller.signal,
        onProgress: ({ updated, failed }) => setProgress({ updated, failed }),
      });
      setStatus("Export complete.");
    }
  } catch (error) {
    if (error?.message === "Canceled." || error?.name === "AbortError") {
      setStatus("Canceled.");
      logLine("Run canceled.");
    } else {
      setStatus("Failed.");
      logLine(error.message || String(error));
    }
  } finally {
    elements.run.disabled = false;
    elements.cancel.disabled = true;
    runState = null;
  }
});
