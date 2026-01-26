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
  return value
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
  elements.tagPreview.textContent = `${prefix}-${todayUtc()}-1`;
}

function normalizeContent(html) {
  if (!html) {
    return "";
  }
  const lower = html.toLowerCase();
  if (lower.includes("<html") || lower.includes("<body")) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body ? doc.body.innerHTML : html;
  }
  return html;
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

async function fetchImageAsDataUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    if (!blob.type || !blob.type.startsWith("image/")) {
      return null;
    }
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    return null;
  }
}

async function inlineImagesInContent(content, baseUrl) {
  const doc = new DOMParser().parseFromString(`<body>${content}</body>`, "text/html");
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
    if (src.startsWith("data:")) {
      skipped += 1;
      continue;
    }
    const resolved = resolveUrl(src, baseUrl);
    if (!resolved) {
      failed += 1;
      continue;
    }
    const dataUrl = await fetchImageAsDataUrl(resolved);
    if (!dataUrl) {
      failed += 1;
      continue;
    }
    img.setAttribute("src", dataUrl);
    img.removeAttribute("srcset");
    inlined += 1;
  }

  return {
    html: doc.body.innerHTML,
    stats: { total: images.length, inlined, failed, skipped },
  };
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

function buildContentOpf(entries, title, author, uid) {
  const manifestItems = entries
    .map(
      (entry, index) =>
        `    <item id="item-${index + 1}" href="${entry.href}" media-type="application/xhtml+xml" />`
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
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`;
}

async function buildChapterXhtml(item) {
  const title = item.title || "Untitled";
  const author = item.author || "";
  const site = item.site_name || "";
  const created = item.created_at ? item.created_at.slice(0, 10) : "";
  const source = item.source_url || item.url || "";

  let content = normalizeContent(item.html_content || "");
  if (!content) {
    content = `<p>Content unavailable from Readwise. <a href="${escapeXml(
      source
    )}">Open source</a>.</p>`;
  }

  let imageStats = null;
  if (content && source) {
    const inlined = await inlineImagesInContent(content, source);
    content = inlined.html;
    imageStats = inlined.stats;
  }
  if (imageStats && imageStats.total > 0) {
    logLine(
      `Images for ${title}: inlined ${imageStats.inlined}/${imageStats.total}, failed ${imageStats.failed}, skipped ${imageStats.skipped}.`
    );
  }

  const byline = [author, site].filter(Boolean).join(" - ");
  const baseTag = source ? `<base href="${escapeXml(source)}" />` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${escapeXml(title)}</title>
    <meta charset="utf-8" />
    ${baseTag}
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

  const entries = items.map((item, index) => ({
    title: item.title || `Untitled ${index + 1}`,
    href: `text/item-${index + 1}.xhtml`,
  }));

  oebps.file("nav.xhtml", buildNavXhtml(entries, options.title));
  oebps.file("toc.ncx", buildTocNcx(entries, options.title, options.uid));
  oebps.file(
    "content.opf",
    buildContentOpf(entries, options.title, options.author, options.uid)
  );

  const textDir = oebps.folder("text");
  for (const [index, item] of items.entries()) {
    const chapter = await buildChapterXhtml(item);
    textDir.file(`item-${index + 1}.xhtml`, chapter);
  }

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
  return `${prefix}-${todayUtc()}-1`;
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
