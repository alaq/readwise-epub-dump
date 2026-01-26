const elements = {
  form: document.querySelector("#controls"),
  token: document.querySelector("#token"),
  location: document.querySelector("#location"),
  tagPrefix: document.querySelector("#tagPrefix"),
  applyTags: document.querySelector("#applyTags"),
  archive: document.querySelector("#archive"),
  run: document.querySelector("#run"),
  status: document.querySelector("#status"),
  log: document.querySelector("#log"),
  download: document.querySelector("#download"),
  tagPreview: document.querySelector("#tagPreview"),
};

const READWISE_API = "https://readwise.io/api/v3";
const RATE_LIMIT_MS = 3000;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function updateTagPreview() {
  const prefix = elements.tagPrefix.value.trim();
  if (!prefix) {
    elements.tagPreview.textContent = "(set a tag prefix)";
    return;
  }
  elements.tagPreview.textContent = `${prefix}-${todayUtc()}`;
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
      const binary = atob(dataPart);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return { mediaType, bytes };
    }
    const decoded = decodeURIComponent(dataPart);
    const bytes = new TextEncoder().encode(decoded);
    return { mediaType, bytes };
  } catch (error) {
    return null;
  }
}

async function fetchImageBytes(url) {
  try {
    const response = await fetch(url);
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

async function embedImagesInDocument(doc, baseUrl, registry) {
  const images = Array.from(doc.querySelectorAll("img"));
  let inlined = 0;
  let failed = 0;
  let skipped = 0;

  for (const img of images) {
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
        const fetched = await fetchImageBytes(resolved);
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

async function fetchAllDocuments(token, location) {
  let cursor = null;
  const items = [];
  let expectedCount = null;

  do {
    const params = new URLSearchParams();
    params.set("withHtmlContent", "true");
    if (location) {
      params.set("location", location);
    }
    if (cursor) {
      params.set("pageCursor", cursor);
    }

    const response = await fetch(`${READWISE_API}/list/?${params.toString()}`, {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
    });

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

    cursor = data.nextPageCursor || null;
    if (cursor) {
      await sleep(RATE_LIMIT_MS);
    }
  } while (cursor);

  return items;
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

function buildContentOpf(entries, imageItems, title, author, uid) {
  const manifestItems = entries
    .map(
      (entry, index) =>
        `    <item id="item-${index + 1}" href="${entry.href}" media-type="application/xhtml+xml" />`
    )
    .join("\n");

  const imageManifestItems = imageItems
    .map(
      (item) =>
        `    <item id="${item.id}" href="${item.href}" media-type="${item.mediaType}" />`
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

async function buildChapterXhtml(item, imageRegistry) {
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
      imageStats = await embedImagesInDocument(doc, source, imageRegistry);
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

  const entries = items.map((item, index) => ({
    title: item.title || `Untitled ${index + 1}`,
    href: `text/item-${index + 1}.xhtml`,
  }));

  const textDir = oebps.folder("text");
  for (const [index, item] of items.entries()) {
    const chapter = await buildChapterXhtml(item, imageRegistry);
    textDir.file(`item-${index + 1}.xhtml`, chapter);
  }

  const imageItems = [];
  if (imageRegistry.map.size > 0) {
    const imagesDir = oebps.folder("images");
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
    buildContentOpf(entries, imageItems, options.title, options.author, options.uid)
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
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of items) {
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

    const response = await fetch(`${READWISE_API}/update/${item.id}/`, {
      method: "PATCH",
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      updated += 1;
    } else {
      failed += 1;
      const body = await response.text();
      logLine(`Update failed for ${item.title || item.id}: ${response.status} ${body}`);
    }

    await sleep(RATE_LIMIT_MS);
  }

  logLine(`Tag/archive updates: ${updated} updated, ${skipped} skipped, ${failed} failed.`);
}

function getTag(prefix) {
  if (!prefix) {
    return "";
  }
  return `${prefix}-${todayUtc()}`;
}

elements.tagPrefix.addEventListener("input", updateTagPreview);
updateTagPreview();

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearLog();
  setStatus("Starting...");
  elements.download.hidden = true;
  elements.run.disabled = true;

  const token = elements.token.value.trim();
  const location = elements.location.value;
  const tagPrefix = elements.tagPrefix.value.trim();
  const applyTags = elements.applyTags.checked;
  const archive = elements.archive.checked;

  if (!token) {
    setStatus("Access token is required.");
    elements.run.disabled = false;
    return;
  }

  const tag = getTag(tagPrefix);
  if (applyTags && !tag) {
    setStatus("Tag prefix is required when tagging is enabled.");
    elements.run.disabled = false;
    return;
  }

  try {
    setStatus("Fetching articles...");
    const items = await fetchAllDocuments(token, location);

    const sorted = items
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const withHtml = sorted.filter((item) => item.html_content).length;
    logLine(`Readwise HTML available for ${withHtml}/${sorted.length} articles.`);

    for (const item of sorted) {
      const title = item.title || "Untitled";
      if (item.html_content) {
        logLine(`Using Readwise HTML for: ${title}`);
      } else {
        logLine(`Missing Readwise HTML for: ${title}`);
      }
    }

    const title = `Readwise Export ${todayUtc()}`;
    const uid = makeUuid();

    setStatus("Building EPUB...");
    const epubBlob = await buildEpub(sorted, {
      title,
      author: "Readwise",
      uid,
    });

    const epubUrl = URL.createObjectURL(epubBlob);
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
      await updateDocuments(sorted, token, {
        applyTags,
        archive,
        tag: tagValue,
      });
      setStatus("Export complete.");
    }
  } catch (error) {
    setStatus("Failed.");
    logLine(error.message || String(error));
  } finally {
    elements.run.disabled = false;
  }
});
