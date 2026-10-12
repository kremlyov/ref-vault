import express from "express";
import multer from "multer";
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createInbox } from "./inbox.js";
import { instagramPostUrl, inspectInstagram } from "./instagram.js";
import { pinterestVideo, pinterestGallery, pinterestPagePayloads } from "./pinterest.js";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

const rawStorage = process.env.REF_VAULT_STORAGE_DIR || path.join(__dirname, "data");
const STORAGE_DIR = path.resolve(rawStorage.replace(/^~(?=\/)/, process.env.HOME || ""));
const MEDIA_DIR = path.join(STORAGE_DIR, "media");
const DB_PATH = path.join(STORAGE_DIR, "db.json");

fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ items: [] }, null, 2));
console.log(`Storage → ${STORAGE_DIR}`);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/media", express.static(MEDIA_DIR));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ dest: MEDIA_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

function loadDb() { try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch { return { items: [] }; } }
function saveDb(db) { const tmp = `${DB_PATH}.tmp`; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, DB_PATH); }
function rid() { return crypto.randomBytes(9).toString("hex"); }
function safeName(v = "file") { return v.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "file"; }
function extFromType(type = "") {
  if (type.includes("jpeg")) return ".jpg";
  if (type.includes("png")) return ".png";
  if (type.includes("webp")) return ".webp";
  if (type.includes("gif")) return ".gif";
  if (type.includes("mp4")) return ".mp4";
  if (type.includes("webm")) return ".webm";
  if (type.includes("quicktime")) return ".mov";
  return "";
}
function siteName(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    if (h.includes("dribbble")) return "Dribbble";
    if (h.includes("behance")) return "Behance";
    if (h.includes("are.na")) return "Are.na";
    if (h.includes("pinterest")) return "Pinterest";
    if (/(^|\.)instagram\.com$/.test(h)) return "Instagram";
    return h;
  } catch { return ""; }
}
function mediaKey(url) {
  try {
    const u = new URL(url);
    let pathname = u.pathname;
    if (/(^|\.)pinimg\.com$/.test(u.hostname)) pathname = pathname.replace(/^\/(?:originals|\d+x(?:\d+)?(?:_RS)?|\d+x\d+_A)\//, "/asset/");
    return `${u.hostname}${pathname}`;
  } catch { return url; }
}
function uniqueMedia(xs) {
  const seen = new Set();
  const out = [];
  for (const x of xs.filter(Boolean)) {
    const k = mediaKey(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

async function inspectArenaBlock(url) {
  const parsed = new URL(url);
  if (!/(^|\.)are\.na$/.test(parsed.hostname)) return null;
  const blockId = parsed.pathname.match(/^\/block\/(\d+)\/?$/)?.[1];
  if (!blockId) return null;
  const response = await fetch(`https://api.are.na/v2/blocks/${blockId}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Are.na API: ${response.status}`);
  const block = await response.json();
  const image = block.image?.original?.url || block.image?.large?.url || block.image?.display?.url || "";
  const attachment = block.attachment;
  const isVideo = attachment && (String(attachment.content_type || "").startsWith("video/") || /\.(mp4|webm|mov)(?:[?#]|$)/i.test(attachment.url || ""));
  const video = isVideo ? attachment.url : "";
  // A video's image is its poster, not a separate work.
  const images = image && !video ? [image] : [];
  if (!images.length && !video) return null;
  return {
    finalUrl: `https://www.are.na/block/${blockId}`,
    title: block.title || `Are.na block ${blockId}`,
    description: block.description || "",
    imageCandidates: images,
    videoCandidates: video ? [video] : [],
    coverImage: image,
    poster: image,
    videoPosters: video && image ? { [video]: image } : {},
    scoped: true,
    warning: ""
  };
}

const instagramInspections = new Map();
async function inspectWithBrowser(url) {
  const instagram = instagramPostUrl(url);
  if (instagram) {
    const cached = instagramInspections.get(instagram);
    if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.result;
    instagramInspections.delete(instagram);
  }
  // The block API exposes original assets directly, avoiding HTML preview proxies.
  try {
    const arena = await inspectArenaBlock(url);
    if (arena) return arena;
  } catch { /* Fall back to the page when the public API is unavailable. */ }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      locale: "en-US"
    });
    const page = await context.newPage();
    if (instagram) {
      const result = await inspectInstagram(page, instagram);
      for (const [key, cached] of instagramInspections) if (Date.now() - cached.time >= 5 * 60 * 1000) instagramInspections.delete(key);
      if (instagramInspections.size >= 20) instagramInspections.delete(instagramInspections.keys().next().value);
      instagramInspections.set(instagram, { time: Date.now(), result });
      return result;
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    // Trigger lazy media in long projects without collecting the recommendation feed.
    if (!/(^|\.)pinterest\.[a-z.]+$/.test(new URL(page.url()).hostname)) await page.evaluate(async () => {
      const height = Math.min(document.body.scrollHeight, 24000);
      for (let y = 0; y < height; y += 800) {
        window.scrollTo(0, y);
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      window.scrollTo(0, 0);
    });

    const data = await page.evaluate(() => {
      const abs = u => { try { return new URL(u, location.href).href; } catch { return ""; } };
      const metas = {};
      document.querySelectorAll("meta").forEach(m => {
        const k = m.getAttribute("property") || m.getAttribute("name");
        const v = m.getAttribute("content");
        if (k && v && !metas[k]) metas[k] = v;
      });
      const largestFromSrcset = (ss = "") => {
        const items = ss.split(",").map(x => x.trim()).filter(Boolean).map(x => {
          const [url, size = ""] = x.split(/\s+/);
          const n = parseInt(size, 10) || 0;
          return { url, n };
        }).sort((a, b) => b.n - a.n);
        return items[0]?.url || "";
      };

      const host = location.hostname;
      const selectors = /(^|\.)dribbble\.com$/.test(host)
        ? [".shot-page .block-media-wrapper", ".shot-media", ".shot-image"]
        : /(^|\.)behance\.net$/.test(host)
        ? [".project-modules", ".project-module"]
        : /(^|\.)are\.na$/.test(host)
        ? ["[data-testid='block-content']", ".block-content"]
        : /(^|\.)pinterest\.[a-z.]+$/.test(host)
        ? ["[data-test-id='pin-closeup-image']", "[data-test-id='pin-closeup-video']", "[data-test-id='pin-closeup-image-container']"]
        : [];
      let roots = [];
      for (const selector of selectors) {
        roots = [...document.querySelectorAll(selector)];
        if (roots.length) break;
      }
      const scoped = roots.length > 0;
      const nodes = selector => [...new Set(roots.flatMap(root => [
        ...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)
      ]))];
      const images = [];
      for (const img of nodes("img")) {
        const best = largestFromSrcset(img.srcset || img.getAttribute("srcset") || "");
        const vals = [best || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.currentSrc || img.src];
        for (const v of vals) if (v) images.push(abs(v));
      }
      for (const source of nodes("picture source")) {
        const best = largestFromSrcset(source.srcset || source.getAttribute("srcset") || "");
        if (best) images.push(abs(best));
      }

      const videos = [];
      const videoPosters = {};
      for (const v of nodes("video")) {
        const urls = [v.currentSrc, v.src, ...[...v.querySelectorAll("source")].map(s => s.src)].filter(Boolean).map(abs);
        for (const u of urls) if (v.poster) videoPosters[u] = abs(v.poster);
        if (v.currentSrc) videos.push(abs(v.currentSrc));
        if (v.src) videos.push(abs(v.src));
        for (const s of v.querySelectorAll("source")) if (s.src) videos.push(abs(s.src));
      }

      const ogImage = metas["og:image:secure_url"] || metas["og:image"] || metas["twitter:image"] || "";
      const poster = nodes("video")[0]?.poster || ogImage || "";

      return {
        finalUrl: location.href,
        structuredMetadata: /(^|\.)pinterest\.[a-z.]+$/.test(host) ? [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(s=>{try{return [JSON.parse(s.textContent)];}catch{return [];}}) : [],
        pinterestScripts: /(^|\.)pinterest\.[a-z.]+$/.test(host) ? [...document.querySelectorAll('script[data-relay-completed-request], script#__PWS_DATA__, script#__PWS_INITIAL_PROPS__')].map(s => s.textContent) : [],
        scoped,
        warning: scoped ? "" : "Основной блок работы не распознан. Найдено только медиа из метаданных страницы — проверь набор перед сохранением.",
        videoPosters,
        title: metas["og:title"] || metas["twitter:title"] || document.title || location.hostname,
        description: metas["og:description"] || metas["description"] || metas["twitter:description"] || "",
        ogImage: abs(ogImage),
        images: (images.length ? images : [abs(ogImage)]).filter(Boolean),
        videos: [metas["og:video:secure_url"], metas["og:video:type"]?.startsWith("video/") ? metas["og:video"] : "", metas["twitter:player:stream"], ...videos].filter(Boolean).map(abs),
        poster: abs(poster)
      };
    });

    const pinVideo = pinterestVideo(data.structuredMetadata, data.finalUrl);
    const pinGallery = pinterestGallery(pinterestPagePayloads(data.pinterestScripts), data.structuredMetadata, data.finalUrl);
    delete data.structuredMetadata;
    delete data.pinterestScripts;
    if (pinVideo) {
      data.images=[];data.videos=[pinVideo.url];data.poster=pinVideo.poster||data.ogImage;
      data.videoPosters={ [pinVideo.url]: data.poster };data.scoped=true;data.warning='';
    } else if (pinGallery.length) {
      data.images=pinGallery;data.videos=[];data.scoped=true;data.warning='';
    }
    let images = uniqueMedia(data.images);
    let videos = uniqueMedia(data.videos);

    // Pinterest renders resized CDN assets; prefer the same asset's original.
    if (/(^|\.)pinterest\.[a-z.]+$/.test(new URL(data.finalUrl).hostname)) {
      images = await Promise.all(images.map(async image => {
        const u = new URL(image);
        if (!/(^|\.)pinimg\.com$/.test(u.hostname) || !/^\/(?:\d+x(?:\d+)?(?:_RS)?|\d+x\d+_A)\//.test(u.pathname)) return image;
        for (const size of ["originals", "1200x"]) {
          const candidate = new URL(image);
          candidate.pathname = candidate.pathname.replace(/^\/[^/]+\//, `/${size}/`);
          try {
            const response = await context.request.head(candidate.href, { timeout: 10000 });
            if (response.ok() && (response.headers()["content-type"] || "").startsWith("image/")) return candidate.href;
          } catch { /* Keep the available preview when a larger asset is missing. */ }
        }
        return image;
      }));
    }

    if (new URL(data.finalUrl).hostname.includes("dribbble.com")) {
      const preferred = images.filter(u => /cdn\.dribbble\.com/i.test(u) && !/\/assets\/|avatar|logo|badge|announcement|profile/i.test(u));
      if (preferred.length) images = preferred;
      videos = videos.filter(u => /dribbble|cloudfront|amazonaws|cdn/i.test(u) && !/avatar|logo|badge/i.test(u));
    }

    const coverImage = images[0] || data.poster || data.ogImage || "";
    return { ...data, imageCandidates: images.slice(0, 40), videoCandidates: videos.slice(0, 20), coverImage };
  } finally {
    await browser.close();
  }
}

async function saveRemote(url, prefix = "asset", referer = "") {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150 Safari/537.36",
    "Accept": "*/*"
  };
  if (referer) headers.Referer = referer;
  const r = await fetch(url, { redirect: "follow", headers });
  if (!r.ok) throw new Error(`Медиа вернуло ${r.status}`);
  const type = r.headers.get("content-type") || "";
  if (!type.startsWith("image/") && !type.startsWith("video/")) throw new Error(`Неизвестный тип ${type || "файла"}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const pathname = new URL(r.url).pathname;
  const ext = path.extname(pathname) || extFromType(type);
  const filename = `${Date.now()}-${rid()}-${safeName(prefix)}${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, filename), buf);
  return { id: rid(), localUrl: `/media/${filename}`, mime: type, type: type.startsWith("video/") ? "video" : "image", size: buf.length, remoteUrl: url };
}

app.post("/api/inspect", async (req, res) => {
  try {
    const url = String(req.body.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Нужна полная ссылка http(s)://..." });
    const p = await inspectWithBrowser(url);
    res.json({
      sourceUrl: p.finalUrl,
      source: siteName(p.finalUrl),
      title: p.title,
      description: p.description,
      imageCandidates: p.imageCandidates,
      videoCandidates: p.videoCandidates,
      coverImage: p.coverImage,
      poster: p.poster,
      videoPosters: p.videoPosters,
      warning: p.warning
    });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "Не удалось открыть страницу" });
  }
});

async function archiveReference(input) {
    const { url, tags = [], note = "", collection = "", selectedMedia, coverMedia, inboxJobId } = input;
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Нужна ссылка http(s)://...");
    if (inboxJobId) {
      const existing = loadDb().items.find(item => item.inboxJobId === inboxJobId);
      if (existing) return existing;
    }
    const p = await inspectWithBrowser(url);
    let found = [
      ...p.imageCandidates.map(remoteUrl => ({ type: "image", remoteUrl })),
      ...p.videoCandidates.map(remoteUrl => ({ type: "video", remoteUrl }))
    ];
    if (Array.isArray(selectedMedia)) {
      const selected = new Set(selectedMedia.map(mediaKey));
      found = found.filter(m => selected.has(mediaKey(m.remoteUrl)));
    }
    if (!found.length) throw new Error("Медиа не найдено. Попробуй ручную загрузку файла.");

    const archivedMedia = [];
    const errors = [];
    for (let i = 0; i < found.length; i++) {
      const m = found[i];
      try {
        const saved = await saveRemote(m.remoteUrl, `${p.title}-${i + 1}`, p.finalUrl);
        if (saved.type === "video" && p.videoPosters[m.remoteUrl]) {
          try {
            const poster = await saveRemote(p.videoPosters[m.remoteUrl], `${p.title}-poster-${i + 1}`, p.finalUrl);
            saved.posterUrl = poster.localUrl;
          } catch (e) { errors.push({ remoteUrl: p.videoPosters[m.remoteUrl], error: e.message }); }
        }
        archivedMedia.push(saved);
      } catch (e) {
        errors.push({ remoteUrl: m.remoteUrl, error: e.message });
      }
    }

    const coverRemote = p.coverImage || p.imageCandidates[0] || "";
    const coverKey = mediaKey(coverRemote);
    const coverSaved = archivedMedia.find(m => mediaKey(m.remoteUrl) === coverKey && m.type === "image");
    if (!archivedMedia.length) throw new Error("Не удалось сохранить ни одного медиа. Попробуй ручную загрузку.");
    let coverUrl = coverSaved?.localUrl || archivedMedia.find(m => m.type === "image")?.localUrl || archivedMedia.find(m => m.posterUrl)?.posterUrl || "";
    const chosenCover = coverMedia ? archivedMedia.find(m => mediaKey(m.remoteUrl) === mediaKey(coverMedia)) || archivedMedia[0] : null;
    if (chosenCover) coverUrl = chosenCover.type === "image" ? chosenCover.localUrl : chosenCover.posterUrl || "";

    if (!coverUrl && p.poster && (!chosenCover || chosenCover.remoteUrl === p.videoCandidates[0])) {
      try {
        const posterSaved = await saveRemote(p.poster, `${p.title}-cover`, p.finalUrl);
        if (chosenCover) chosenCover.posterUrl = posterSaved.localUrl;
        else archivedMedia.unshift(posterSaved);
        coverUrl = posterSaved.localUrl;
      } catch {
        coverUrl = "";
      }
    }

    const item = {
      id: rid(),
      ...(inboxJobId ? { inboxJobId } : {}),
      createdAt: new Date().toISOString(),
      sourceUrl: p.finalUrl,
      source: siteName(p.finalUrl),
      title: p.title,
      description: p.description || "",
      note: String(note || ""),
      collection: String(collection || ""),
      tags: Array.isArray(tags) ? tags : String(tags || "").split(",").map(x => x.trim()).filter(Boolean),
      coverUrl,
      ...(chosenCover ? { coverMediaId: chosenCover.id } : {}),
      media: archivedMedia,
      mediaFound: found.length,
      mediaArchived: archivedMedia.length,
      archiveErrors: errors
    };

    const db = loadDb();
    db.items.unshift(item);
    saveDb(db);
    return item;
}

app.post("/api/save-url", async (req, res) => {
  try { res.json(await archiveReference(req.body)); }
  catch (e) { res.status(400).json({ error: e.message || "Не удалось сохранить" }); }
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) throw new Error("Файл не выбран");
    const ext = path.extname(req.file.originalname || "");
    const finalName = `${Date.now()}-${rid()}-${safeName(path.basename(req.file.originalname || "file", ext))}${ext}`;
    fs.renameSync(req.file.path, path.join(MEDIA_DIR, finalName));
    const mime = req.file.mimetype || "";
    const mediaObj = { id: rid(), localUrl: `/media/${finalName}`, mime, type: mime.startsWith("video/") ? "video" : "image", size: req.file.size || 0, remoteUrl: "" };
    const item = {
      id: rid(), createdAt: new Date().toISOString(), sourceUrl: req.body.sourceUrl || "", source: req.body.source || "Manual",
      title: req.body.title || req.file.originalname || "Файл", description: "", note: req.body.note || "", collection: req.body.collection || "",
      tags: String(req.body.tags || "").split(",").map(x => x.trim()).filter(Boolean), coverUrl: mediaObj.type === "image" ? mediaObj.localUrl : "",
      media: [mediaObj], mediaFound: 1, mediaArchived: 1, archiveErrors: []
    };
    const db = loadDb(); db.items.unshift(item); saveDb(db); res.json(item);
  } catch (e) { res.status(400).json({ error: e.message || "Не удалось загрузить" }); }
});

app.get("/api/items", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const type = String(req.query.type || "").trim().toLowerCase();
  let items = loadDb().items || [];
  items = items.map(x => {
    if (!x.media && (x.mediaUrl || x.remoteMediaUrl)) {
      x.media = [{ id: rid(), localUrl: x.mediaUrl || "", remoteUrl: x.remoteMediaUrl || "", mime: x.mediaType === "video" ? "video/mp4" : "image/*", type: x.mediaType || "image" }];
      x.coverUrl = x.coverUrl || (x.mediaType === "image" ? (x.mediaUrl || x.remoteMediaUrl) : x.posterUrl || "");
      x.mediaFound = x.media.length;
      x.mediaArchived = x.archived ? 1 : 0;
    }
    return x;
  });
  items = items.filter(x => {
    const hay = [x.title, x.description, x.note, x.source, x.collection, ...(x.tags || [])].join(" ").toLowerCase();
    const hasType = !type || (x.media || []).some(m => m.type === type);
    return (!q || hay.includes(q)) && hasType;
  });
  res.json(items);
});

app.get("/api/stats", (req, res) => {
  const a = loadDb().items || [];
  const media = a.flatMap(x => x.media || []);
  res.json({ total: a.length, images: media.filter(x => x.type === "image").length, videos: media.filter(x => x.type === "video").length, archived: media.filter(x => x.localUrl).length });
});

function itemLocalFiles(item) {
  return new Set([
    item.coverUrl, item.mediaUrl, item.posterUrl,
    ...(item.media || []).flatMap(m => [m.localUrl, m.posterUrl])
  ].filter(url => typeof url === "string" && url.startsWith("/media/"))
    .map(url => path.basename(url)));
}

function bulkSelection(db, body) {
  if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.some(id => typeof id !== "string" || !id.trim())) {
    const error = new Error("Выбери хотя бы один реф"); error.status = 400; throw error;
  }
  const ids = new Set(body.ids);
  const items = db.items.filter(item => ids.has(item.id));
  if (items.length !== ids.size) {
    const error = new Error("Некоторые выбранные рефы уже удалены. Обнови страницу и выбери их заново."); error.status = 409; throw error;
  }
  return { ids, items };
}

app.patch("/api/items/bulk", (req, res) => {
  try {
    const db = loadDb(), { items } = bulkSelection(db, req.body);
    const { addTags = [], collection } = req.body;
    if (!Array.isArray(addTags) || addTags.some(tag => typeof tag !== "string") ||
        (collection !== undefined && (typeof collection !== "string" || !collection.trim()))) {
      return res.status(400).json({ error: "Укажи теги или название коллекции" });
    }
    const key = value => value.trim().normalize("NFC").toLocaleLowerCase("ru-RU");
    const knownTags = new Map();
    for (const item of db.items) for (const tag of item.tags || []) if (!knownTags.has(key(tag))) knownTags.set(key(tag), tag);
    const tags = [...new Set(addTags.map(tag => tag.trim()).filter(Boolean).map(key))]
      .map(tagKey => knownTags.get(tagKey) || addTags.find(tag => key(tag) === tagKey).trim());
    if (!tags.length && collection === undefined) return res.status(400).json({ error: "Добавь теги или укажи коллекцию" });
    const targetCollection = collection === undefined ? undefined : db.items.find(item => item.collection && key(item.collection) === key(collection))?.collection || collection.trim();
    for (const item of items) {
      if (tags.length) {
        const existing = new Set((item.tags || []).map(key));
        item.tags = [...(item.tags || []), ...tags.filter(tag => !existing.has(key(tag)))];
      }
      if (targetCollection !== undefined) item.collection = targetCollection;
    }
    saveDb(db);
    res.json({ ok: true, updated: items.length });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Не удалось изменить выбранные рефы" }); }
});

app.delete("/api/items/bulk", (req, res) => {
  try {
    const db = loadDb(), { ids, items } = bulkSelection(db, req.body);
    db.items = db.items.filter(item => !ids.has(item.id));
    const retained = new Set(db.items.flatMap(item => [...itemLocalFiles(item)]));
    const removed = new Set(items.flatMap(item => [...itemLocalFiles(item)]));
    saveDb(db);
    for (const filename of removed) {
      if (retained.has(filename)) continue;
      try { fs.unlinkSync(path.join(MEDIA_DIR, filename)); }
      catch (e) { if (e.code !== "ENOENT") console.error("Не удалось удалить файл:", filename, e.message); }
    }
    res.json({ ok: true, deleted: items.length });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Не удалось удалить выбранные рефы" }); }
});

app.delete("/api/items/:id", (req, res) => {
  try {
    const db = loadDb();
    const item = db.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Работа не найдена" });
    db.items = db.items.filter(i => i.id !== req.params.id);
    const retained = new Set(db.items.flatMap(i => [...itemLocalFiles(i)]));
    saveDb(db);
    for (const filename of itemLocalFiles(item)) {
      if (retained.has(filename)) continue;
      try { fs.unlinkSync(path.join(MEDIA_DIR, filename)); }
      catch (e) { if (e.code !== "ENOENT") console.error("Не удалось удалить файл:", filename, e.message); }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Не удалось удалить работу" });
  }
});

app.patch("/api/items/:id", (req, res) => {
  const db = loadDb();
  const x = db.items.find(i => i.id === req.params.id);
  if (!x) return res.status(404).json({ error: "Не найдено" });
  for (const k of ["title", "note", "collection", "tags", "coverUrl"]) if (req.body[k] !== undefined) x[k] = req.body[k];
  saveDb(db);
  res.json(x);
});

const inbox = createInbox({ storageDir: STORAGE_DIR, archiveReference });
app.get("/api/inbox", (req, res) => res.json(inbox.snapshot()));
app.post("/api/inbox/:id/retry", (req, res) => {
  try { inbox.retry(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`REF/VAULT v0.3 → http://localhost:${PORT}`));
