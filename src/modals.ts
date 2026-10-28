import { App, DataAdapter, Modal, Notice, TFile, requestUrl } from "obsidian";
import { NavItem } from "epubjs";
import type MyEpubPlugin from "./main";

export const EXAMPLE_SEP = " — ";
const TRANSLATE_PER_POS = 4;
const TRANSLATE_TIMEOUT_MS = 10000;
const MAX_TRANSLATION_CACHE = 2000;
const TRANSLATION_CACHE_DEBOUNCE_MS = 2000;
const TRANSLATION_CACHE_FILENAME = "translations-cache.json";

export const normStr = (s: string) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
export const normText = (s: string) =>
  String(s ?? "").toLowerCase().replace(/[“”"']/g, "").replace(/\s+/g, " ").trim();

// B4: лёгкая нормализация окончаний (-s, -es, -ed, -ing, -ly) только для ключа поиска дублей
function lightStemToken(token: string): string {
  const w = token.trim();
  if (w.length < 4) return w;

  if (w.endsWith("ies") && w.length >= 5) {
    return w.slice(0, -3) + "y";
  }
  if (w.endsWith("ly") && w.length >= 5) {
    return w.slice(0, -2);
  }
  if (w.endsWith("ing") && w.length >= 6) {
    const stem = w.slice(0, -3);
    const last = stem.charAt(stem.length - 1);
    const prev = stem.charAt(stem.length - 2);
    if (stem.length >= 4 && last === prev && /[bdfgklmnprstvz]/.test(last)) {
      return stem.slice(0, -1);
    }
    return stem;
  }
  if (w.endsWith("ed") && w.length >= 5) {
    const stem = w.slice(0, -2);
    const last = stem.charAt(stem.length - 1);
    const prev = stem.charAt(stem.length - 2);
    if (stem.length >= 4 && last === prev && /[bdfgklmnprstvz]/.test(last)) {
      return stem.slice(0, -1);
    }
    return stem;
  }
  if (w.endsWith("es") && w.length >= 5) {
    if (/(ches|shes|xes|zes|sses)$/.test(w)) {
      return w.slice(0, -2);
    }
    return w.slice(0, -1);
  }
  if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) {
    return w.slice(0, -1);
  }
  return w;
}

export const wordKey = (s: string): string => {
  const base = normText(s).replace(/^(to|a|an|the)\s+/, "");
  if (!base) return "";
  return base
    .split(" ")
    .filter(Boolean)
    .map(lightStemToken)
    .join(" ");
};

export const cleanExample = (s: string) =>
  String(s ?? "").replace(/\s+/g, " ").replace(/:{2,}/g, ":").replace(/==|\*\*/g, "").trim();

export const encodeInline = (s: string) =>
  String(s ?? "").replace(/\r?\n|\r/g, " ").replace(/\)/g, "⟩").replace(/\(/g, "⟨").trim();

const decodeInline = (s: string) =>
  String(s ?? "").replace(/⟩/g, ")").replace(/⟨/g, "(").trim();

export function getTodayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function speakEnglishText(text: string) {
  const clean = String(text ?? "").replace(/\[.*?\]/g, "").trim();
  if (!clean || typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = "en-US";
    utter.rate = 0.94;
    const voices = window.speechSynthesis.getVoices?.() || [];
    const preferred =
      voices.find(
        (v) => /en[-_](US|GB)/i.test(v.lang) && /natural|google|samantha|daniel|alex/i.test(v.name)
      ) || voices.find((v) => /^en/i.test(v.lang));
    if (preferred) utter.voice = preferred;
    window.speechSynthesis.speak(utter);
  } catch {
    // Игнорируем ошибку TTS
  }
}

export function cleanSelectedWord(raw: string): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.,!?;:()"“”«»„‟'‘’—–\-[\]{}<>/\\|]+|[\s.,!?;:()"“”«»„‟'‘’—–\-[\]{}<>/\\|]+$/g, "")
    .trim();
}

export function cleanSelectedQuote(raw: string): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

// B3: Защита сокращений (Mr., Dr., U.S., e.g. и инициалов) от ложного разрыва предложения
const ABBREV_END_REGEX =
  /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|fig|vol|ch|pp|no|e\.g|i\.e|U\.S|U\.K|Ph\.D|[A-Z])\.$/i;

function mergeAbbreviationSplits(rawSegments: string[]): string[] {
  const merged: string[] = [];
  for (const seg of rawSegments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const prev = merged[merged.length - 1];
    if (prev && ABBREV_END_REGEX.test(prev)) {
      merged[merged.length - 1] = `${prev} ${trimmed}`;
    } else {
      merged.push(trimmed);
    }
  }
  return merged;
}

function splitParagraphIntoSentences(paragraph: string): string[] {
  try {
    const IntlAny = typeof Intl !== "undefined" ? (Intl as any) : null;
    if (IntlAny && typeof IntlAny.Segmenter === "function") {
      const segmenter = new IntlAny.Segmenter("en", { granularity: "sentence" });
      const rawList = Array.from(segmenter.segment(paragraph), (item: any) =>
        String(item?.segment ?? "").trim()
      ).filter(Boolean);
      if (rawList.length > 0) {
        return mergeAbbreviationSplits(rawList);
      }
    }
  } catch {
    // Переходим к запасному варианту
  }

  // Запасной вариант с маскировкой точек внутри сокращений (Mr., Dr., U.S. и т.д.)
  const DOT_PLACEHOLDER = "\uE000";
  const masked = paragraph
    .replace(
      /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|fig|vol|ch|pp|no)\./gi,
      `$1${DOT_PLACEHOLDER}`
    )
    .replace(/\b(e\.g|i\.e|U\.S|U\.K|Ph\.D)\./gi, (m) => m.replace(/\./g, DOT_PLACEHOLDER))
    .replace(/\b([A-Z])\.(?=\s+[A-Z])/g, `$1${DOT_PLACEHOLDER}`);

  const matches = masked.match(/[^.!?]+[.!?]+["”»'’)]*|[^.!?]+$/g) || [masked];
  return matches
    .map((s) => s.replace(/\uE000/g, ".").trim())
    .filter(Boolean);
}

// B3: Умное извлечение полного предложения из абзаца книги вокруг выделенного слова
export function extractSentenceFromSelection(sel: Selection | null | undefined, word: string): string {
  if (!sel || sel.rangeCount === 0) return "";
  try {
    const range = sel.getRangeAt(0);
    let node: Node | null = range.startContainer;
    let blockEl: HTMLElement | null = null;

    while (node && node.nodeName !== "BODY" && node.nodeName !== "HTML") {
      if (node.nodeType === 1) {
        const tag = (node as HTMLElement).tagName.toUpperCase();
        if (/^(P|LI|BLOCKQUOTE|DD|DT|H1|H2|H3|H4|H5|H6|DIV|TD)$/.test(tag)) {
          blockEl = node as HTMLElement;
          break;
        }
      }
      node = node.parentNode;
    }

    const rawText = (blockEl ? blockEl.textContent : range.startContainer.textContent) || "";
    const paragraph = rawText.replace(/\s+/g, " ").trim();
    if (!paragraph) return "";

    const sentences = splitParagraphIntoSentences(paragraph);
    const cleanW = word.trim().toLowerCase();

    for (const s of sentences) {
      const trimmed = s.trim();
      if (cleanW && trimmed.toLowerCase().includes(cleanW)) {
        return cleanExample(trimmed);
      }
    }
    return cleanExample(sentences[0]?.trim() || "");
  } catch {
    return "";
  }
}

export function extractLinkTarget(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "object" && (raw as any).path) return String((raw as any).path).trim();
  const str = String(raw).trim();
  const clean = str.startsWith("[[") && str.endsWith("]]") ? str.slice(2, -2) : str;
  const barIdx = clean.indexOf("|");
  const hashIdx = clean.indexOf("#");
  let cutIdx = clean.length;
  if (barIdx !== -1 && barIdx < cutIdx) cutIdx = barIdx;
  if (hashIdx !== -1 && hashIdx < cutIdx) cutIdx = hashIdx;
  const target = clean.slice(0, cutIdx).trim();
  return target || null;
}

export interface BookNoteInfo {
  file: TFile;
  path: string;
  fileName: string;
  title: string;
  author: string;
  status: string;
  bookPropRaw: string;
  linkedEpubPath: string | null;
}

export function loadBookNotesFromVault(app: App, booksFolder: string): BookNoteInfo[] {
  const folderPrefix = booksFolder.replace(/\/+$/, "") + "/";
  const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folderPrefix));
  const result: BookNoteInfo[] = [];

  for (const f of files) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter || {};
    const title = String(fm["название"] || f.basename).trim();
    const author = String(fm["автор"] || "").trim();
    const status = String(fm["статус"] || "В планах").trim();
    const rawBook = fm["книга"] !== undefined && fm["книга"] !== null ? String(fm["книга"]).trim() : "";

    let linkedEpubPath: string | null = null;
    const linkTarget = extractLinkTarget(rawBook);
    if (linkTarget) {
      const dest = app.metadataCache.getFirstLinkpathDest(linkTarget, f.path);
      linkedEpubPath = dest ? dest.path : linkTarget;
    }

    result.push({
      file: f,
      path: f.path,
      fileName: f.basename,
      title,
      author,
      status,
      bookPropRaw: rawBook,
      linkedEpubPath,
    });
  }

  return result;
}

export function findMatchingBookNotes(
  app: App,
  epubFile: TFile,
  booksFolder: string
): { exactByProp: BookNoteInfo[]; byTitle: BookNoteInfo[]; all: BookNoteInfo[] } {
  const all = loadBookNotesFromVault(app, booksFolder);

  const exactByProp = all.filter((b) => {
    if (!b.linkedEpubPath) return false;
    return (
      b.linkedEpubPath === epubFile.path ||
      normStr(b.linkedEpubPath) === normStr(epubFile.name) ||
      normStr(b.linkedEpubPath) === normStr(epubFile.basename)
    );
  });

  if (exactByProp.length > 0) {
    return { exactByProp, byTitle: [], all };
  }

  const epubNorm = normStr(epubFile.basename);
  const byTitle = all.filter((b) => {
    const tNorm = normStr(b.title);
    const fNorm = normStr(b.fileName);
    return (
      tNorm === epubNorm ||
      fNorm === epubNorm ||
      (tNorm.length >= 4 && epubNorm.includes(tNorm))
    );
  });

  return { exactByProp: [], byTitle, all };
}

export async function ensureFolderExists(app: App, folderPath: string) {
  const parts = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) {
      await app.vault.createFolder(current);
    }
  }
}

export async function ensureQuotesFile(app: App, quotesFilePath: string): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(quotesFilePath);
  if (existing instanceof TFile) return existing;

  const folder = quotesFilePath.includes("/")
    ? quotesFilePath.slice(0, quotesFilePath.lastIndexOf("/"))
    : "";
  if (folder) await ensureFolderExists(app, folder);

  const initialContent =
    "---\nтип: Цитатник\nнаправление: Досуг\n---\n\n# 📚 Цитаты, мысли и принципы\n\n";
  return await app.vault.create(quotesFilePath, initialContent);
}

// --- B1: Переводчик с постоянным кэшем в отдельном JSON плагина (лимит 2000, ленивая загрузка, debounce) ---
export interface TranslationGroup {
  pos: string;
  terms: string[];
}

interface TranslationCacheRecord {
  groups: TranslationGroup[];
  updatedAt: number;
}

const translationCache = new Map<string, TranslationCacheRecord>();
let cacheAdapter: DataAdapter | null = null;
let cacheFilePath = "";
let cacheLoadedFromDisk = false;
let cacheLoadPromise: Promise<void> | null = null;
let cacheSaveTimer: number | null = null;

export function configureTranslationCache(app: App, pluginDir?: string) {
  cacheAdapter = app.vault.adapter;
  const dir =
    pluginDir ||
    (app as any)?.plugins?.plugins?.["my-epub-reader"]?.manifest?.dir ||
    `${app.vault.configDir}/plugins/my-epub-reader`;
  cacheFilePath = `${dir}/${TRANSLATION_CACHE_FILENAME}`;
}

function resolveCacheAdapterAndPath(): { adapter: DataAdapter; path: string } | null {
  if (cacheAdapter && cacheFilePath) {
    return { adapter: cacheAdapter, path: cacheFilePath };
  }
  const globalApp: App | undefined =
    typeof window !== "undefined" ? (window as any).app : undefined;
  if (globalApp?.vault?.adapter) {
    configureTranslationCache(globalApp);
    if (cacheAdapter && cacheFilePath) {
      return { adapter: cacheAdapter, path: cacheFilePath };
    }
  }
  return null;
}

async function ensureTranslationCacheLoaded(): Promise<void> {
  if (cacheLoadedFromDisk) return;
  if (cacheLoadPromise) return cacheLoadPromise;

  cacheLoadPromise = (async () => {
    const resolved = resolveCacheAdapterAndPath();
    if (!resolved) {
      cacheLoadedFromDisk = true;
      return;
    }
    try {
      if (await resolved.adapter.exists(resolved.path)) {
        const raw = await resolved.adapter.read(resolved.path);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const entries = Object.entries(parsed as Record<string, TranslationCacheRecord>);
          entries.sort((a, b) => (a[1]?.updatedAt ?? 0) - (b[1]?.updatedAt ?? 0));
          for (const [k, v] of entries) {
            if (v && Array.isArray(v.groups) && v.groups.length > 0) {
              translationCache.set(k, {
                groups: v.groups,
                updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : Date.now(),
              });
            }
          }
          pruneTranslationCacheInMemory();
        }
      }
    } catch {
      // Игнорируем ошибку чтения кэша переводов
    } finally {
      cacheLoadedFromDisk = true;
      cacheLoadPromise = null;
    }
  })();

  return cacheLoadPromise;
}

function pruneTranslationCacheInMemory() {
  if (translationCache.size <= MAX_TRANSLATION_CACHE) return;
  const entries = Array.from(translationCache.entries());
  entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const toRemoveCount = translationCache.size - MAX_TRANSLATION_CACHE;
  for (let i = 0; i < toRemoveCount; i++) {
    const item = entries[i];
    if (item) translationCache.delete(item[0]);
  }
}

function scheduleSaveTranslationCache() {
  if (cacheSaveTimer !== null) window.clearTimeout(cacheSaveTimer);
  cacheSaveTimer = window.setTimeout(async () => {
    cacheSaveTimer = null;
    const resolved = resolveCacheAdapterAndPath();
    if (!resolved) return;
    try {
      pruneTranslationCacheInMemory();
      const obj: Record<string, TranslationCacheRecord> = {};
      for (const [k, v] of translationCache.entries()) {
        obj[k] = v;
      }
      await resolved.adapter.write(resolved.path, JSON.stringify(obj));
    } catch {
      // Игнорируем ошибку фоновой записи кэша
    }
  }, TRANSLATION_CACHE_DEBOUNCE_MS);
}

const DESKTOP_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`нет ответа за ${ms / 1000} с`)), ms)
    ),
  ]);
}

function parseGoogleData(d: any): TranslationGroup[] {
  const groups: TranslationGroup[] = [];
  if (Array.isArray(d?.[1])) {
    d[1].forEach((e: any) => {
      const terms = (Array.isArray(e?.[1]) ? e[1] : []).filter(
        (t: any) => typeof t === "string" && t.trim()
      );
      if (terms.length) {
        groups.push({
          pos: String(e[0] || "перевод"),
          terms: terms.slice(0, TRANSLATE_PER_POS).map((t: string) => t.trim()),
        });
      }
    });
  }
  if (!groups.length && Array.isArray(d?.dict)) {
    d.dict.forEach((entry: any) => {
      const terms = (Array.isArray(entry?.terms) ? entry.terms : []).filter(
        (t: any) => typeof t === "string" && t.trim()
      );
      if (terms.length) {
        groups.push({
          pos: String(entry.pos || "перевод"),
          terms: terms.slice(0, TRANSLATE_PER_POS).map((t: string) => t.trim()),
        });
      }
    });
  }
  if (!groups.length && Array.isArray(d?.sentences)) {
    const main = d.sentences.map((s: any) => s?.trans).filter(Boolean).join("").trim();
    if (main) groups.push({ pos: "перевод", terms: [main] });
  }
  if (!groups.length && Array.isArray(d?.[0])) {
    const main = d[0].map((s: any) => s?.[0]).filter(Boolean).join("").trim();
    if (main) groups.push({ pos: "перевод", terms: [main] });
  }
  return groups;
}

export async function fetchTranslations(word: string): Promise<TranslationGroup[]> {
  const cleanWord = String(word ?? "").trim();
  if (!cleanWord) throw new Error("пустой запрос");

  await ensureTranslationCacheLoaded();

  const cacheKey = cleanWord.toLowerCase();
  const cached = translationCache.get(cacheKey);
  if (cached && cached.groups.length > 0) {
    cached.updatedAt = Date.now();
    scheduleSaveTranslationCache();
    return cached.groups;
  }

  const q = encodeURIComponent(cleanWord);
  const endpoints = [
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=ru&q=${q}`,
    `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dt=bd&dj=1&sl=en&tl=ru&q=${q}`,
    `https://translate.google.com/translate_a/single?client=at&sl=en&tl=ru&dt=t&dt=bd&q=${q}`,
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&dt=bd&q=${q}`,
  ];

  let lastErr: any = null;
  for (const url of endpoints) {
    try {
      const r = await withTimeout(requestUrl({ url, headers: DESKTOP_HEADERS }), TRANSLATE_TIMEOUT_MS);
      const data = typeof r.json === "object" && r.json !== null ? r.json : JSON.parse(r.text);
      const groups = parseGoogleData(data);
      if (groups.length) {
        translationCache.set(cacheKey, { groups, updatedAt: Date.now() });
        pruneTranslationCacheInMemory();
        scheduleSaveTranslationCache();
        return groups;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  try {
    const fallbackUrl = `https://api.mymemory.translated.net/get?q=${q}&langpair=en%7Cru`;
    const r = await withTimeout(
      requestUrl({ url: fallbackUrl, headers: DESKTOP_HEADERS }),
      TRANSLATE_TIMEOUT_MS
    );
    const data = typeof r.json === "object" && r.json !== null ? r.json : JSON.parse(r.text);
    const termsSet = new Set<string>();

    const mainText = data?.responseData?.translatedText;
    if (typeof mainText === "string" && mainText.trim() && mainText.toLowerCase() !== cacheKey) {
      termsSet.add(mainText.trim().toLowerCase());
    }
    if (Array.isArray(data?.matches)) {
      data.matches.forEach((m: any) => {
        const t = String(m?.translation ?? "").trim();
        if (t && t.toLowerCase() !== cacheKey && !/[a-zA-Z]{3,}/.test(t)) {
          termsSet.add(t.toLowerCase());
        }
      });
    }

    const terms = [...termsSet].slice(0, TRANSLATE_PER_POS);
    if (terms.length) {
      const groups = [{ pos: "перевод", terms }];
      translationCache.set(cacheKey, { groups, updatedAt: Date.now() });
      pruneTranslationCacheInMemory();
      scheduleSaveTranslationCache();
      return groups;
    }
  } catch (e) {
    lastErr = e;
  }

  throw lastErr || new Error("сервисы перевода временно недоступны");
}

interface ExistingWordCard {
  lineNumber: number;
  front: string;
  word: string;
  back: string;
  key: string;
}

function parseExistingWordsForDuplicates(content: string): ExistingWordCard[] {
  const lines = String(content ?? "").split(/\r?\n/);
  const result: ExistingWordCard[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const srIdx = line.indexOf("<!--SR:");
    const cardPart = srIdx === -1 ? line : line.slice(0, srIdx);
    if (!/:{2,3}/.test(cardPart) || cardPart.trimStart().startsWith("#")) continue;

    const parts = cardPart.split(/:{2,3}/);
    const rawFront = (parts[0] ?? "").replace(/^[-*+]\s+/, "").trim();
    const rawBackJoined = parts.slice(1).join(" ").trim();

    const exIdx = rawFront.indexOf(EXAMPLE_SEP);
    const word = exIdx === -1 ? rawFront : rawFront.slice(0, exIdx).trim();

    let cleanBack = rawBackJoined;
    const inlineMatch = rawBackJoined.match(
      /^(.*?)\s*\((?:источник|книга)::\s*(\[\[[^\]]+\]\])\)\s*(?![\s\S])/i
    );
    if (inlineMatch?.[1] !== undefined) {
      cleanBack = inlineMatch[1].trim();
    } else {
      const dotMatch = rawBackJoined.match(/^(.*?)\s*(?:·|\|)\s*(\[\[[^\]]+\]\])\s*(?![\s\S])/);
      if (dotMatch?.[1] !== undefined) {
        cleanBack = dotMatch[1].trim();
      }
    }

    result.push({
      lineNumber: i + 1,
      front: rawFront,
      word,
      back: cleanBack,
      key: wordKey(word),
    });
  }

  return result;
}

// B2: Парсер существующих цитат для проверки дублей внутри выбранной книги
interface ExistingQuoteRecord {
  lineNumber: number;
  text: string;
  normKey: string;
  bookTarget: string | null;
  bookTitleNorm: string;
}

function parseExistingQuotesForDuplicates(content: string): ExistingQuoteRecord[] {
  const lines = String(content ?? "").split(/\r?\n/);
  const result: ExistingQuoteRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("-") || !line.includes("цитата::")) continue;

    const fields: Record<string, string> = {};
    const fieldRegex = /\(([а-яА-Яa-zA-Z0-9_]+)::\s*([^)]+)\)/g;
    for (const m of line.matchAll(fieldRegex)) {
      const k = m[1]?.trim();
      const v = m[2]?.trim();
      if (k && v) fields[k] = v;
    }

    const rawText = fields["цитата"] ? decodeInline(fields["цитата"]) : "";
    if (!rawText) continue;

    const linkTarget =
      extractLinkTarget(fields["книга_ссылка"]) || extractLinkTarget(fields["книга"]);
    const bookTitleNorm = normStr(decodeInline(fields["книга"] || ""));

    result.push({
      lineNumber: i + 1,
      text: rawText,
      normKey: normText(rawText),
      bookTarget: linkTarget,
      bookTitleNorm,
    });
  }

  return result;
}

function isQuoteInSelectedBook(q: ExistingQuoteRecord, book: BookNoteInfo | null): boolean {
  if (!book) return false;
  if (q.bookTarget) {
    const cleanTarget = normStr(q.bookTarget.replace(/\.md$/i, ""));
    if (
      cleanTarget === normStr(book.fileName) ||
      cleanTarget === normStr(book.title) ||
      normStr(q.bookTarget) === normStr(book.path)
    ) {
      return true;
    }
  }
  return q.bookTitleNorm !== "" && q.bookTitleNorm === normStr(book.title);
}

function safeCloseModal(modal: Modal) {
  try {
    (modal as any).shouldRestoreSelection = false;
    modal.close();
  } catch (e) {
    console.log("Safe modal close:", e);
  }
}

// --- 1. Оглавление ---
export class TocModal extends Modal {
  toc: NavItem[];
  onSelect: (href: string) => void;

  constructor(app: App, toc: NavItem[], onSelect: (href: string) => void) {
    super(app);
    (this as any).shouldRestoreSelection = false;
    this.toc = toc;
    this.onSelect = onSelect;
  }

  onOpen() {
    (this as any).shouldRestoreSelection = false;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("my-epub-toc-modal");
    contentEl.createEl("h3", { text: "📑 Оглавление" });

    if (!this.toc || this.toc.length === 0) {
      contentEl.createDiv({ cls: "my-epub-toc-empty", text: "В этой книге нет оглавления." });
      return;
    }

    const list = contentEl.createDiv("my-epub-toc-list");
    this.renderItems(list, this.toc, 0);
  }

  renderItems(container: HTMLElement, items: NavItem[], level: number) {
    for (const item of items) {
      const row = container.createDiv({ cls: "my-epub-toc-item" });
      row.style.paddingLeft = `${0.75 + level * 1.25}rem`;
      row.setText((item.label || "Без названия").trim());
      row.onclick = () => {
        this.onSelect(item.href);
        safeCloseModal(this);
      };
      if (item.subitems && item.subitems.length > 0) {
        this.renderItems(container, item.subitems, level + 1);
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- 1.5. Быстрый переход к странице или проценту ---
export class JumpToPageModal extends Modal {
  currentPage: number;
  totalPages: number;
  chapterInfoText: string;
  onJumpPage: (page: number) => void;

  constructor(
    app: App,
    currentPage: number,
    totalPages: number,
    chapterInfoText: string,
    onJumpPage: (page: number) => void
  ) {
    super(app);
    (this as any).shouldRestoreSelection = false;
    this.currentPage = currentPage;
    this.totalPages = totalPages;
    this.chapterInfoText = chapterInfoText;
    this.onJumpPage = onJumpPage;
  }

  onOpen() {
    (this as any).shouldRestoreSelection = false;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("my-epub-modal");

    contentEl.createEl("h3", { text: "🧭 Переход по книге" });

    if (this.chapterInfoText) {
      contentEl.createDiv({
        cls: "my-epub-modal-sub",
        text: this.chapterInfoText,
      });
    }

    const row = contentEl.createDiv("my-epub-modal-row");
    const pageInput = row.createEl("input", {
      cls: "my-epub-input-en",
      type: "number",
      attr: {
        min: "1",
        max: String(this.totalPages),
        step: "1",
        placeholder: `Страница (1 – ${this.totalPages})`,
      },
      value: String(this.currentPage),
    });

    const goBtn = row.createEl("button", {
      cls: "mod-cta my-epub-modal-btn",
      text: "Перейти",
    });

    const sliderWrap = contentEl.createDiv("my-epub-modal-section");
    const pctNow = Math.round((this.currentPage / Math.max(1, this.totalPages)) * 100);
    const sliderLabel = sliderWrap.createDiv({
      cls: "my-epub-modal-label",
      text: `Позиция: стр. ${this.currentPage} из ${this.totalPages} (${pctNow}%)`,
    });

    const rangeInput = sliderWrap.createEl("input", {
      type: "range",
      attr: {
        min: "1",
        max: String(this.totalPages),
        step: "1",
        style: "width: 100%; cursor: pointer;",
      },
      value: String(this.currentPage),
    });

    rangeInput.oninput = () => {
      const p = Math.max(1, Math.min(this.totalPages, Number(rangeInput.value) || 1));
      const pct = Math.round((p / Math.max(1, this.totalPages)) * 100);
      pageInput.value = String(p);
      sliderLabel.setText(`Позиция: стр. ${p} из ${this.totalPages} (${pct}%)`);
    };

    pageInput.oninput = () => {
      const p = Math.max(1, Math.min(this.totalPages, Number(pageInput.value) || 1));
      const pct = Math.round((p / Math.max(1, this.totalPages)) * 100);
      rangeInput.value = String(p);
      sliderLabel.setText(`Позиция: стр. ${p} из ${this.totalPages} (${pct}%)`);
    };

    const doJump = () => {
      const target = Math.max(1, Math.min(this.totalPages, Number(pageInput.value) || 1));
      this.onJumpPage(target);
      safeCloseModal(this);
    };

    goBtn.onclick = doJump;
    pageInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doJump();
      }
    };

    window.setTimeout(() => {
      pageInput.focus();
      pageInput.select();
    }, 40);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- 2. Привязка или создание заметки книги ---
export class BookLinkModal extends Modal {
  epubFile: TFile;
  booksFolder: string;
  candidates: BookNoteInfo[];
  allBooks: BookNoteInfo[];
  defaultTitle: string;
  defaultAuthor: string;
  currentPage: number | null;
  totalPages: number | null;
  currentPct: number | null;
  onResolved: (bookNote: BookNoteInfo) => void;

  constructor(
    app: App,
    epubFile: TFile,
    booksFolder: string,
    candidates: BookNoteInfo[],
    allBooks: BookNoteInfo[],
    defaultTitle: string,
    defaultAuthor: string,
    currentPage: number | null,
    totalPages: number | null,
    currentPct: number | null,
    onResolved: (bookNote: BookNoteInfo) => void
  ) {
    super(app);
    (this as any).shouldRestoreSelection = false;
    this.epubFile = epubFile;
    this.booksFolder = booksFolder;
    this.candidates = candidates;
    this.allBooks = allBooks;
    this.defaultTitle = defaultTitle;
    this.defaultAuthor = defaultAuthor;
    this.currentPage = currentPage;
    this.totalPages = totalPages;
    this.currentPct = currentPct;
    this.onResolved = onResolved;
  }

  onOpen() {
    (this as any).shouldRestoreSelection = false;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("my-epub-modal");

    contentEl.createEl("h3", { text: "📖 Привязка заметки книги" });
    contentEl.createDiv({
      cls: "my-epub-modal-sub",
      text: `Файл: ${this.epubFile.path}`,
    });

    const existingBox = contentEl.createDiv("my-epub-modal-section");
    existingBox.createDiv({
      cls: "my-epub-modal-label",
      text:
        this.candidates.length > 0
          ? "Найдена похожая заметка в «" + this.booksFolder + "»:"
          : "Выбрать существующую заметку из «" + this.booksFolder + "»:",
    });

    if (this.allBooks.length > 0) {
      const row = existingBox.createDiv("my-epub-modal-row");
      const select = row.createEl("select", { cls: "dropdown my-epub-input-flex" });

      const sorted = [...this.allBooks].sort((a, b) => {
        const aCand = this.candidates.some((c) => c.path === a.path) ? 0 : 1;
        const bCand = this.candidates.some((c) => c.path === b.path) ? 0 : 1;
        if (aCand !== bCand) return aCand - bCand;
        const aRead = a.status === "Читаю" ? 0 : 1;
        const bRead = b.status === "Читаю" ? 0 : 1;
        return aRead - bRead || a.title.localeCompare(b.title, "ru", { sensitivity: "base" });
      });

      sorted.forEach((b, idx) => {
        const isCand = this.candidates.some((c) => c.path === b.path);
        const prefix = isCand ? "★ " : b.status === "Читаю" ? "📖 " : "";
        const opt = select.createEl("option", {
          text: `${prefix}${b.title}${b.author ? " — " + b.author : ""} [${b.status}]`,
          value: b.path,
        });
        if (idx === 0) opt.selected = true;
      });

      const linkBtn = row.createEl("button", {
        cls: "mod-cta my-epub-modal-btn",
        text: "Привязать выбранную",
      });

      const confirmConflictBox = existingBox.createDiv({
        cls: "my-epub-conflict-box",
      });
      confirmConflictBox.style.display = "none";

      linkBtn.onclick = async () => {
        const chosen = this.allBooks.find((b) => b.path === select.value);
        if (!chosen) return;

        const existingVal = chosen.bookPropRaw;
        const targetWiki = `[[${this.epubFile.path}]]`;

        if (
          existingVal &&
          existingVal !== targetWiki &&
          extractLinkTarget(existingVal) !== this.epubFile.path
        ) {
          confirmConflictBox.empty();
          confirmConflictBox.style.display = "flex";
          confirmConflictBox.createDiv({
            text: `⚠️ В заметке «${chosen.title}» свойство «книга» уже занято: ${existingVal}. Перезаписать его ссылкой на этот EPUB?`,
          });
          const btnRow = confirmConflictBox.createDiv("my-epub-modal-row");
          const yesBtn = btnRow.createEl("button", {
            cls: "mod-cta my-epub-modal-btn",
            text: "Да, перезаписать",
          });
          const noBtn = btnRow.createEl("button", {
            cls: "my-epub-modal-btn",
            text: "Только для этого сеанса (не менять YAML)",
          });

          yesBtn.onclick = async () => {
            await this.writeBookLinkToFrontmatter(chosen);
          };
          noBtn.onclick = () => {
            this.onResolved(chosen);
            safeCloseModal(this);
          };
          return;
        }

        await this.writeBookLinkToFrontmatter(chosen);
      };
    } else {
      existingBox.createDiv({
        cls: "my-epub-modal-sub",
        text: "В папке ещё нет заметок книг.",
      });
    }

    const createBox = contentEl.createDiv("my-epub-modal-section");
    createBox.createDiv({
      cls: "my-epub-modal-label",
      text: "Или создать новую заметку книги в «" + this.booksFolder + "»:",
    });

    const grid = createBox.createDiv("my-epub-modal-grid");
    const titleInp = grid.createEl("input", {
      type: "text",
      placeholder: "Название книги *",
      value: this.defaultTitle,
    });
    const authorInp = grid.createEl("input", {
      type: "text",
      placeholder: "Автор",
      value: this.defaultAuthor,
    });
    const genreInp = grid.createEl("input", {
      type: "text",
      placeholder: "Жанр (необязательно)",
    });

    const createBtnRow = createBox.createDiv("my-epub-modal-row-end");
    const createBtn = createBtnRow.createEl("button", {
      cls: "my-epub-modal-btn",
      text: "+ Создать заметку книги",
    });

    createBtn.onclick = async () => {
      const title = titleInp.value.trim();
      const author = authorInp.value.trim();
      const genre = genreInp.value.trim();

      if (!title) {
        new Notice("Укажи название книги.");
        return;
      }

      createBtn.disabled = true;
      let resolvedInfo: BookNoteInfo | null = null;
      try {
        await ensureFolderExists(this.app, this.booksFolder);
        const safeBase = title.replace(/[\\/:*?"<>|#^\[\]]/g, "").trim();
        if (!safeBase) throw new Error("Некорректное название книги.");

        const folderPrefix = this.booksFolder.replace(/\/+$/, "");
        let targetPath = `${folderPrefix}/${safeBase}.md`;
        if (this.app.vault.getAbstractFileByPath(targetPath)) {
          const safeAuthor = author.replace(/[\\/:*?"<>|#^\[\]]/g, "").trim();
          if (safeAuthor) {
            targetPath = `${folderPrefix}/${safeBase} (${safeAuthor}).md`;
          }
          if (this.app.vault.getAbstractFileByPath(targetPath)) {
            throw new Error(`Заметка «${targetPath}» уже существует. Выбери её в списке выше.`);
          }
        }

        const wikiLink = `[[${this.epubFile.path}]]`;
        const todayISO = getTodayISO();
        const hasTotal = this.totalPages !== null && this.totalPages > 0;
        const hasRead = this.currentPage !== null && this.currentPage >= 0;
        const hasPct = this.currentPct !== null && this.currentPct >= 0;

        const yamlLines = [
          "---",
          `название: ${JSON.stringify(title)}`,
          `автор: ${JSON.stringify(author)}`,
          `жанр: ${JSON.stringify(genre)}`,
          `статус: "Читаю"`,
          `страниц: ${hasTotal ? this.totalPages : ""}`,
          `прочитано: ${hasRead ? this.currentPage : ""}`,
          `прогресс: ${hasPct ? this.currentPct : ""}`,
          `последнее_чтение: ${JSON.stringify(todayISO)}`,
          `книга: ${JSON.stringify(wikiLink)}`,
          "---",
          "",
          `# ${title}`,
          "",
        ];

        const created = await this.app.vault.create(targetPath, yamlLines.join("\n"));
        resolvedInfo = {
          file: created,
          path: created.path,
          fileName: created.basename,
          title,
          author,
          status: "Читаю",
          bookPropRaw: wikiLink,
          linkedEpubPath: this.epubFile.path,
        };
        new Notice(`Создана и привязана книга «${title}»`);
      } catch (e: any) {
        new Notice("Ошибка: " + (e?.message || e));
        createBtn.disabled = false;
        return;
      }

      if (resolvedInfo) {
        this.onResolved(resolvedInfo);
        safeCloseModal(this);
      }
    };
  }

  async writeBookLinkToFrontmatter(chosen: BookNoteInfo) {
    const wikiLink = `[[${this.epubFile.path}]]`;
    const todayISO = getTodayISO();
    try {
      await this.app.fileManager.processFrontMatter(chosen.file, (fm) => {
        fm["книга"] = wikiLink;
        if (this.totalPages !== null && this.totalPages > 0) {
          fm["страниц"] = this.totalPages;
        }
        if (this.currentPage !== null && this.currentPage > 0) {
          fm["прочитано"] = this.currentPage;
        }
        if (this.currentPct !== null && this.currentPct >= 0) {
          fm["прогресс"] = this.currentPct;
        }
        fm["последнее_чтение"] = todayISO;
        if (!fm["статус"] || fm["статус"] === "В планах") {
          fm["статус"] = "Читаю";
        }
      });
      chosen.bookPropRaw = wikiLink;
      chosen.linkedEpubPath = this.epubFile.path;
      new Notice(`Книга привязана к заметке «${chosen.title}»`);
    } catch (e: any) {
      new Notice("Ошибка записи YAML: " + (e?.message || e));
      return;
    }
    this.onResolved(chosen);
    safeCloseModal(this);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- 3. Модальное окно «+ Слово» (B5: cachedRead при открытии, vault.read перед записью) ---
export class AddWordModal extends Modal {
  plugin: MyEpubPlugin;
  initialWord: string;
  capturedCfi: string | null;
  extractedContextSentence: string;
  preselectedBook: BookNoteInfo | null;
  allBooks: BookNoteInfo[];
  selectedVariants: string[] = [];
  translatedGroups: TranslationGroup[] = [];
  existingCards: ExistingWordCard[] = [];

  constructor(
    app: App,
    plugin: MyEpubPlugin,
    initialWord: string,
    capturedCfi: string | null,
    extractedContextSentence: string,
    preselectedBook: BookNoteInfo | null,
    allBooks: BookNoteInfo[]
  ) {
    super(app);
    (this as any).shouldRestoreSelection = false;
    this.plugin = plugin;
    this.initialWord = initialWord;
    this.capturedCfi = capturedCfi;
    this.extractedContextSentence = extractedContextSentence;
    this.preselectedBook = preselectedBook;
    this.allBooks = allBooks;
    configureTranslationCache(app, plugin.manifest?.dir);
  }

  async onOpen() {
    (this as any).shouldRestoreSelection = false;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("my-epub-modal");

    const wordsFile = this.resolveWordsFile();
    if (wordsFile) {
      try {
        // B5: используем cachedRead при открытии модального окна
        const raw = await this.app.vault.cachedRead(wordsFile);
        this.existingCards = parseExistingWordsForDuplicates(raw);
      } catch {
        this.existingCards = [];
      }
    }

    const head = contentEl.createDiv("my-epub-word-head");
    head.createSpan({ cls: "my-epub-word-title", text: "Новое слово или выражение" });

    const mainRow = contentEl.createDiv("my-epub-modal-row");
    const enInput = mainRow.createEl("input", {
      cls: "my-epub-input-en",
      type: "text",
      placeholder: "Слово или выражение (EN) *",
      value: this.initialWord,
    });

    const speakBtn = mainRow.createEl("button", {
      cls: "my-epub-modal-btn",
      text: "🔊",
      attr: { title: "Озвучить слово" },
    });
    speakBtn.onclick = () => speakEnglishText(enInput.value);

    const trBtn = mainRow.createEl("button", {
      cls: "my-epub-modal-btn",
      text: "🌐 Перевести",
    });

    const ruInput = mainRow.createEl("input", {
      cls: "my-epub-input-ru",
      type: "text",
      placeholder: "Перевод (RU) *",
    });

    const variantsBox = contentEl.createDiv("my-epub-variants-box");
    variantsBox.style.display = "none";

    const secondRow = contentEl.createDiv("my-epub-modal-row");
    const exInput = secondRow.createEl("input", {
      cls: "my-epub-input-ex",
      type: "text",
      placeholder: "Пример предложения (необязательно)",
      value: "",
    });

    if (this.extractedContextSentence) {
      const fromBookBtn = secondRow.createEl("button", {
        cls: "my-epub-modal-btn",
        text: "📖 Из книги",
        attr: { title: `Вставить из книги: «${this.extractedContextSentence}»` },
      });
      fromBookBtn.onclick = () => {
        if (exInput.value.trim() === this.extractedContextSentence) {
          exInput.value = "";
          fromBookBtn.setText("📖 Из книги");
        } else {
          exInput.value = this.extractedContextSentence;
          fromBookBtn.setText("✕ Убрать пример");
        }
      };
    }

    const sourceSelect = secondRow.createEl("select", {
      cls: "dropdown my-epub-source-select",
    });
    sourceSelect.createEl("option", { text: "Источник: без книги", value: "" });

    const sortedBooks = [...this.allBooks].sort((a, b) => {
      const aR = a.status === "Читаю" ? 0 : 1;
      const bR = b.status === "Читаю" ? 0 : 1;
      return aR - bR || a.title.localeCompare(b.title, "ru", { sensitivity: "base" });
    });

    for (const b of sortedBooks) {
      const opt = sourceSelect.createEl("option", {
        text: (b.status === "Читаю" ? "📖 " : "") + b.title,
        value: b.path,
      });
      if (this.preselectedBook && b.path === this.preselectedBook.path) {
        opt.selected = true;
      }
    }

    const addBtn = secondRow.createEl("button", {
      cls: "mod-cta my-epub-modal-btn",
      text: "+ Сохранить",
    });

    const dupHint = contentEl.createDiv("my-epub-dup-hint");
    dupHint.style.display = "none";

    const showDup = (list: ExistingWordCard[]) => {
      dupHint.empty();
      if (!list.length) {
        dupHint.style.display = "none";
        return;
      }
      dupHint.style.display = "block";
      list.slice(0, 3).forEach((c) => {
        dupHint.createDiv({
          text: `⚠️ Уже есть в базе: ${c.front} ::: ${c.back} (строка ${c.lineNumber})`,
        });
      });
    };

    const checkDuplicatesLive = () => {
      const k = wordKey(enInput.value);
      showDup(k ? this.existingCards.filter((c) => c.key === k) : []);
    };
    checkDuplicatesLive();

    let pendingKey: string | null = null;
    const resetPending = () => {
      pendingKey = null;
      addBtn.setText("+ Сохранить");
    };

    const applySelectedVariants = () => {
      ruInput.value = this.selectedVariants.join("; ");
      resetPending();
    };

    const renderVariants = (groups: TranslationGroup[]) => {
      variantsBox.empty();
      if (!groups.length) {
        variantsBox.style.display = "none";
        return;
      }
      variantsBox.style.display = "flex";
      for (const g of groups) {
        const row = variantsBox.createDiv("my-epub-variant-row");
        row.createSpan({ cls: "my-epub-variant-pos", text: g.pos });
        for (const term of g.terms) {
          const chip = row.createEl("button", {
            cls: "my-epub-variant-chip",
            text: term,
          });
          const paint = () => {
            chip.toggleClass("is-selected", this.selectedVariants.includes(term));
          };
          chip.onclick = () => {
            this.selectedVariants = this.selectedVariants.includes(term)
              ? this.selectedVariants.filter((x) => x !== term)
              : [...this.selectedVariants, term];
            paint();
            applySelectedVariants();
          };
          paint();
        }
      }
    };

    const doTranslate = async () => {
      const en = enInput.value.trim();
      if (!en) {
        new Notice("Сначала впиши английское слово или выражение.");
        enInput.focus();
        return;
      }
      if (trBtn.disabled) return;
      trBtn.disabled = true;
      trBtn.setText("⏳...");
      try {
        const groups = await fetchTranslations(en);
        if (!groups.length) {
          new Notice("Переводов не найдено — впиши вручную.");
          this.translatedGroups = [];
          this.selectedVariants = [];
          renderVariants([]);
          return;
        }
        this.translatedGroups = groups;
        this.selectedVariants = [];
        const firstTerm = groups[0]?.terms?.[0];
        if (groups.length === 1 && firstTerm) {
          this.selectedVariants = [firstTerm];
          applySelectedVariants();
        }
        renderVariants(groups);
      } catch (e: any) {
        new Notice("Не удалось получить перевод: " + (e?.message || e) + ". Впиши вручную.");
      } finally {
        trBtn.disabled = false;
        trBtn.setText("🌐 Перевести");
      }
    };

    enInput.oninput = () => {
      resetPending();
      this.translatedGroups = [];
      this.selectedVariants = [];
      renderVariants([]);
      checkDuplicatesLive();
    };

    ruInput.oninput = () => resetPending();

    const submitWord = async () => {
      if (addBtn.disabled) return;
      const en = enInput.value.trim().replace(/\s+/g, " ");
      const ru = ruInput.value.trim().replace(/\s+/g, " ");
      const ex = cleanExample(exInput.value);
      const chosenBook = this.allBooks.find((b) => b.path === sourceSelect.value) || null;

      if (!en || !ru) {
        new Notice("Заполни и английское слово, и русский перевод.");
        return;
      }

      const targetWordsFile = this.resolveWordsFile();
      if (!targetWordsFile) {
        new Notice(
          `Файл словаря «${this.plugin.settings.wordsFilePath || "Words Cards"}» не найден в хранилище.`
        );
        return;
      }

      addBtn.disabled = true;
      let savedSuccessfully = false;
      let noticeText = "";

      try {
        // B5: перед записью читаем актуальное содержимое через vault.read
        const freshContent = await this.app.vault.read(targetWordsFile);
        const freshCards = parseExistingWordsForDuplicates(freshContent);
        const k = wordKey(en);
        const same = freshCards.filter((c) => c.key === k);

        if (same.length) {
          showDup(same);
          const exact = same.some((c) => normText(c.back) === normText(ru));
          if (exact) {
            new Notice("Такая карточка с этим переводом уже есть — дубликат не добавлен.");
            addBtn.disabled = false;
            return;
          }
          const pk = `${k}|${normText(ru)}`;
          if (pendingKey !== pk) {
            pendingKey = pk;
            addBtn.setText("Всё равно добавить");
            new Notice(
              "Слово уже есть с другим переводом. Нажми ещё раз, если хочешь добавить ещё одну карточку."
            );
            addBtn.disabled = false;
            return;
          }
        }

        const front = ex ? `${en}${EXAMPLE_SEP}${ex}` : en;
        let backWithSource = ru;
        if (chosenBook) {
          const cleanCfi =
            this.capturedCfi && !/[\[\]|#]/.test(this.capturedCfi) ? this.capturedCfi.trim() : "";
          const wiki = cleanCfi
            ? `[[${chosenBook.fileName}#${cleanCfi}|${chosenBook.fileName}]]`
            : `[[${chosenBook.fileName}]]`;
          backWithSource = `${ru} · ${wiki}`;
        }

        const prefix = freshContent.length > 0 && !freshContent.endsWith("\n") ? "\n" : "";
        await this.app.vault.append(targetWordsFile, `${prefix}${front} ::: ${backWithSource}\n`);

        savedSuccessfully = true;
        noticeText = `✓ Добавлено: ${front} ::: ${ru}${chosenBook ? " (" + chosenBook.title + ")" : ""}`;
      } catch (e: any) {
        new Notice("Ошибка добавления: " + (e?.message || e));
        addBtn.disabled = false;
        return;
      }

      if (savedSuccessfully) {
        new Notice(noticeText);
        safeCloseModal(this);
      }
    };

    trBtn.onclick = doTranslate;
    addBtn.onclick = submitWord;
    enInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void doTranslate();
      }
    };
    ruInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submitWord();
      }
    };
    exInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submitWord();
      }
    };

    if (this.initialWord) {
      void doTranslate();
    } else {
      window.setTimeout(() => enInput.focus(), 40);
    }
  }

  resolveWordsFile(): TFile | null {
    const rawPath = (this.plugin.settings.wordsFilePath || "Words Cards").trim();
    const direct = this.app.vault.getAbstractFileByPath(rawPath);
    if (direct instanceof TFile) return direct;
    const withMd = this.app.vault.getAbstractFileByPath(
      rawPath.endsWith(".md") ? rawPath : `${rawPath}.md`
    );
    if (withMd instanceof TFile) return withMd;
    const dest = this.app.metadataCache.getFirstLinkpathDest(rawPath, "");
    if (dest instanceof TFile) return dest;
    return null;
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- 4. Модальное окно «+ Цитата» (B2: проверка дублей по normText внутри выбранной книги) ---
export class AddQuoteModal extends Modal {
  plugin: MyEpubPlugin;
  initialQuote: string;
  capturedCfi: string | null;
  preselectedBook: BookNoteInfo | null;
  allBooks: BookNoteInfo[];
  existingQuotes: ExistingQuoteRecord[] = [];

  constructor(
    app: App,
    plugin: MyEpubPlugin,
    initialQuote: string,
    capturedCfi: string | null,
    preselectedBook: BookNoteInfo | null,
    allBooks: BookNoteInfo[]
  ) {
    super(app);
    (this as any).shouldRestoreSelection = false;
    this.plugin = plugin;
    this.initialQuote = initialQuote;
    this.capturedCfi = capturedCfi;
    this.preselectedBook = preselectedBook;
    this.allBooks = allBooks;
  }

  async onOpen() {
    (this as any).shouldRestoreSelection = false;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("my-epub-modal");

    const quotesPath = (this.plugin.settings.quotesFilePath || "Знания/Цитаты из книг.md").trim();
    const existingFile = this.app.vault.getAbstractFileByPath(quotesPath);
    if (existingFile instanceof TFile) {
      try {
        const raw = await this.app.vault.cachedRead(existingFile);
        this.existingQuotes = parseExistingQuotesForDuplicates(raw);
      } catch {
        this.existingQuotes = [];
      }
    }

    const head = contentEl.createDiv("my-epub-word-head");
    head.createSpan({ cls: "my-epub-word-title", text: "✍️ Новая цитата из книги" });

    const bookRow = contentEl.createDiv("my-epub-modal-row");
    const bookSel = bookRow.createEl("select", { cls: "dropdown my-epub-input-flex" });

    const sortedBooks = [...this.allBooks].sort((a, b) => {
      const aR = a.status === "Читаю" ? 0 : 1;
      const bR = b.status === "Читаю" ? 0 : 1;
      return aR - bR || a.title.localeCompare(b.title, "ru", { sensitivity: "base" });
    });

    for (const b of sortedBooks) {
      const authorPart = b.author ? ` — ${b.author}` : "";
      const opt = bookSel.createEl("option", {
        text: `${b.title}${authorPart} [${b.status}]`,
        value: b.path,
      });
      if (this.preselectedBook && b.path === this.preselectedBook.path) {
        opt.selected = true;
      }
    }

    const textArea = contentEl.createEl("textarea", {
      cls: "my-epub-quote-textarea",
      attr: {
        rows: "4",
        placeholder: "Текст цитаты из книги *",
      },
    });
    textArea.value = this.initialQuote;

    const dupHint = contentEl.createDiv("my-epub-dup-hint");
    dupHint.style.display = "none";

    const btnRow = contentEl.createDiv("my-epub-modal-row-end");
    const saveBtn = btnRow.createEl("button", {
      cls: "mod-cta my-epub-modal-btn",
      text: "+ Сохранить цитату",
    });

    let pendingQuoteKey: string | null = null;
    const resetPending = () => {
      pendingQuoteKey = null;
      saveBtn.setText("+ Сохранить цитату");
    };

    const getChosenBook = (): BookNoteInfo | null => {
      return this.allBooks.find((b) => b.path === bookSel.value) || this.preselectedBook;
    };

    const showDupQuotes = (dups: ExistingQuoteRecord[]) => {
      dupHint.empty();
      if (!dups.length) {
        dupHint.style.display = "none";
        return;
      }
      dupHint.style.display = "block";
      dups.slice(0, 2).forEach((q) => {
        const preview = q.text.length > 75 ? q.text.slice(0, 74) + "…" : q.text;
        dupHint.createDiv({
          text: `⚠️ Такая цитата уже есть в этой книге (строка ${q.lineNumber}): «${preview}»`,
        });
      });
    };

    const checkDuplicatesLive = () => {
      const chosenBook = getChosenBook();
      const nk = normText(textArea.value);
      if (!nk || !chosenBook) {
        showDupQuotes([]);
        return;
      }
      const matches = this.existingQuotes.filter(
        (q) => q.normKey === nk && isQuoteInSelectedBook(q, chosenBook)
      );
      showDupQuotes(matches);
    };
    checkDuplicatesLive();

    textArea.oninput = () => {
      resetPending();
      checkDuplicatesLive();
    };
    bookSel.onchange = () => {
      resetPending();
      checkDuplicatesLive();
    };

    const submitQuote = async () => {
      if (saveBtn.disabled) return;
      const textVal = textArea.value.trim();
      if (!textVal) {
        new Notice("Введи текст цитаты.");
        textArea.focus();
        return;
      }

      const chosenBook = getChosenBook();
      if (!chosenBook) {
        new Notice("Сначала выбери книгу.");
        return;
      }

      saveBtn.disabled = true;
      let savedOk = false;
      try {
        const qFile = await ensureQuotesFile(this.app, quotesPath);
        const freshContent = await this.app.vault.read(qFile);
        const freshQuotes = parseExistingQuotesForDuplicates(freshContent);
        const nk = normText(textVal);
        const sameInBook = freshQuotes.filter(
          (q) => q.normKey === nk && isQuoteInSelectedBook(q, chosenBook)
        );

        if (sameInBook.length > 0) {
          showDupQuotes(sameInBook);
          const pk = `${chosenBook.path}|${nk}`;
          if (pendingQuoteKey !== pk) {
            pendingQuoteKey = pk;
            saveBtn.setText("Всё равно добавить");
            new Notice(
              "Эта цитата уже есть в выбранной книге. Нажми ещё раз, если всё равно хочешь сохранить."
            );
            saveBtn.disabled = false;
            return;
          }
        }

        const todayISO = getTodayISO();
        const cleanLink = encodeInline(`[[${chosenBook.path}]]`);
        const cleanTitle = encodeInline(chosenBook.title);
        const cleanText = encodeInline(textVal);
        const posPart = this.capturedCfi
          ? ` (позиция:: ${encodeInline(this.capturedCfi)})`
          : "";

        const entryLine = `\n- (категория:: Книга) (книга_ссылка:: ${cleanLink}) (книга:: ${cleanTitle}) (дата:: ${todayISO})${posPart} (цитата:: ${cleanText})`;
        await this.app.vault.append(qFile, entryLine);
        savedOk = true;
      } catch (e: any) {
        new Notice("Ошибка сохранения цитаты: " + (e?.message || e));
        saveBtn.disabled = false;
        return;
      }

      if (savedOk) {
        new Notice(`✓ Цитата сохранена в «${chosenBook.title}»`);
        safeCloseModal(this);
      }
    };

    saveBtn.onclick = submitQuote;
    textArea.onkeydown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void submitQuote();
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}