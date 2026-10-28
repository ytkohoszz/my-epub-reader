import { App, Modal, Notice, TFile } from "obsidian";
import { Book, NavItem, Rendition } from "epubjs";
import {
  BookNoteInfo,
  EXAMPLE_SEP,
  TranslationGroup,
  configureTranslationCache,
  extractLinkTarget,
  fetchTranslations,
  normStr,
  speakEnglishText,
} from "./modals";

export interface BookmarkItem {
  cfi: string;
  page: number;
  pct: number;
  label: string;
  createdAt: string;
}

export interface BookWordEntry {
  word: string;
  back: string;
  example: string;
  cfi: string | null;
  lineNumber: number;
}

export interface BookQuoteEntry {
  text: string;
  date: string;
  cfi: string | null;
  lineNumber: number;
}

interface BookSearchMatch {
  cfi: string;
  excerpt: string;
  chapterLabel: string;
}

const MAX_SEARCH_RESULTS = 50;

let activeAnnotationsApp: App | null = null;
let activeWordsFilePath = "Words Cards";
let activeQuotesFilePath = "Знания/Цитаты из книг.md";
let activeHighlightPopoverCleanup: (() => void) | null = null;

const decodeInline = (s: string) =>
  String(s ?? "").replace(/⟩/g, ")").replace(/⟨/g, "(").trim();

function extractLinkCfi(raw: string): string | null {
  const str = decodeInline(String(raw ?? "")).trim();
  if (!str.startsWith("[[") || !str.endsWith("]]")) return null;
  const inner = str.slice(2, -2);
  const hashIdx = inner.indexOf("#");
  if (hashIdx === -1) return null;
  const barIdx = inner.indexOf("|");
  const endIdx = barIdx !== -1 && barIdx > hashIdx ? barIdx : inner.length;
  let anchor = inner.slice(hashIdx + 1, endIdx).trim();
  if (anchor.startsWith("cfi=")) anchor = anchor.slice(4).trim();
  return anchor.startsWith("epubcfi(") ? anchor : null;
}

function isSameBookTarget(targetStr: string | null, book: BookNoteInfo): boolean {
  if (!targetStr) return false;
  const clean = normStr(targetStr.replace(/\.md$/i, ""));
  return (
    clean === normStr(book.fileName) ||
    clean === normStr(book.title) ||
    normStr(targetStr) === normStr(book.path)
  );
}

function resolveVaultFile(app: App, rawPath: string): TFile | null {
  const clean = rawPath.trim();
  const direct = app.vault.getAbstractFileByPath(clean);
  if (direct instanceof TFile) return direct;
  const withMd = app.vault.getAbstractFileByPath(
    clean.endsWith(".md") ? clean : `${clean}.md`
  );
  if (withMd instanceof TFile) return withMd;
  const dest = app.metadataCache.getFirstLinkpathDest(clean, "");
  return dest instanceof TFile ? dest : null;
}

async function openVaultFileAtLine(app: App | null, rawPath: string, lineNumberOneBased: number) {
  const targetApp = app ?? (typeof window !== "undefined" ? (window as any).app : null);
  if (!targetApp) return;

  const file = resolveVaultFile(targetApp, rawPath);
  if (!file) {
    new Notice(`Файл «${rawPath}» не найден.`);
    return;
  }

  const leaf = targetApp.workspace.getLeaf(false);
  await leaf.openFile(file);

  const lineIdx = Math.max(0, (lineNumberOneBased || 1) - 1);
  window.setTimeout(() => {
    try {
      const view: any = targetApp.workspace.activeLeaf?.view;
      const editor = view?.editor;
      if (editor) {
        editor.setCursor({ line: lineIdx, ch: 0 });
        editor.scrollIntoView(
          { from: { line: lineIdx, ch: 0 }, to: { line: lineIdx, ch: 0 } },
          true
        );
        editor.focus();
      }
    } catch {
      // Игнорируем
    }
  }, 120);
}

export async function loadBookAnnotationsFromVault(
  app: App,
  linkedBook: BookNoteInfo | null,
  wordsFilePath: string,
  quotesFilePath: string
): Promise<{ words: BookWordEntry[]; quotes: BookQuoteEntry[] }> {
  activeAnnotationsApp = app;
  activeWordsFilePath = wordsFilePath || "Words Cards";
  activeQuotesFilePath = quotesFilePath || "Знания/Цитаты из книг.md";
  configureTranslationCache(app);

  if (!linkedBook) return { words: [], quotes: [] };

  const words: BookWordEntry[] = [];
  const quotes: BookQuoteEntry[] = [];

  const wordsFile = resolveVaultFile(app, activeWordsFilePath);
  if (wordsFile) {
    try {
      const content = await app.vault.cachedRead(wordsFile);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const srIdx = line.indexOf("<!--SR:");
        const cardPart = srIdx === -1 ? line : line.slice(0, srIdx);
        if (!/:{2,3}/.test(cardPart) || cardPart.trimStart().startsWith("#")) continue;

        const parts = cardPart.split(/:{2,3}/);
        const rawFront = (parts[0] ?? "").replace(/^[-*+]\s+/, "").trim();
        const rawBackJoined = parts.slice(1).join(" ").trim();

        let cleanBack = rawBackJoined;
        let wiki: string | null = null;

        const inlineMatch = rawBackJoined.match(
          /^(.*?)\s*\((?:источник|книга)::\s*(\[\[[^\]]+\]\])\)\s*(?![\s\S])/i
        );
        if (inlineMatch && inlineMatch[1] !== undefined && inlineMatch[2] !== undefined) {
          cleanBack = inlineMatch[1].trim();
          wiki = inlineMatch[2].trim();
        } else {
          const dotMatch = rawBackJoined.match(
            /^(.*?)\s*(?:·|\|)\s*(\[\[[^\]]+\]\])\s*(?![\s\S])/
          );
          if (dotMatch && dotMatch[1] !== undefined && dotMatch[2] !== undefined) {
            cleanBack = dotMatch[1].trim();
            wiki = dotMatch[2].trim();
          }
        }

        if (!wiki) continue;
        const target = extractLinkTarget(wiki);
        if (!isSameBookTarget(target, linkedBook)) continue;

        const exIdx = rawFront.indexOf(EXAMPLE_SEP);
        const word = exIdx === -1 ? rawFront : rawFront.slice(0, exIdx).trim();
        const example = exIdx === -1 ? "" : rawFront.slice(exIdx + EXAMPLE_SEP.length).trim();

        words.push({
          word,
          back: cleanBack,
          example,
          cfi: extractLinkCfi(wiki),
          lineNumber: i + 1,
        });
      }
    } catch {
      // Игнорируем ошибку чтения
    }
  }

  const quotesFile = resolveVaultFile(app, activeQuotesFilePath);
  if (quotesFile) {
    try {
      const content = await app.vault.cachedRead(quotesFile);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? "").trim();
        if (!line.startsWith("-") || !line.includes("цитата::")) continue;

        const fields: Record<string, string> = {};
        const fieldRegex = /\(([а-яА-Яa-zA-Z0-9_]+)::\s*([^)]+)\)/g;
        for (const match of line.matchAll(fieldRegex)) {
          const k = match[1]?.trim();
          const v = match[2]?.trim();
          if (k && v) fields[k] = v;
        }

        const quoteText = fields["цитата"] ? decodeInline(fields["цитата"]) : "";
        if (!quoteText) continue;

        const linkTarget =
          extractLinkTarget(fields["книга_ссылка"]) || extractLinkTarget(fields["книга"]);
        const rawBookTitle = decodeInline(fields["книга"] || "");

        if (
          !isSameBookTarget(linkTarget, linkedBook) &&
          normStr(rawBookTitle) !== normStr(linkedBook.title)
        ) {
          continue;
        }

        const cfi = fields["позиция"] ? decodeInline(fields["позиция"]).trim() : null;
        quotes.push({
          text: quoteText,
          date: decodeInline(fields["дата"] || ""),
          cfi: cfi && cfi.startsWith("epubcfi(") ? cfi : null,
          lineNumber: i + 1,
        });
      }
    } catch {
      // Игнорируем
    }
  }

  return { words: words.reverse(), quotes: quotes.reverse() };
}

// C4: учитываем как системную тёмную тему (body.theme-dark), так и локальные режимы «Ночь» / «Сепия»
function highlightStyles(fill: string, opacity: string): Record<string, string> {
  const isNightView = document.querySelector(".view-content.my-epub.my-epub-is-night") !== null;
  const isSepiaView = document.querySelector(".view-content.my-epub.my-epub-is-sepia") !== null;
  const isDark = isNightView || (!isSepiaView && document.body.classList.contains("theme-dark"));
  return {
    fill,
    "fill-opacity": isDark ? "0.38" : opacity,
    "mix-blend-mode": isDark ? "normal" : "multiply",
  };
}

function closeActiveHighlightPopover() {
  if (activeHighlightPopoverCleanup) {
    const fn = activeHighlightPopoverCleanup;
    activeHighlightPopoverCleanup = null;
    try {
      fn();
    } catch {
      // Игнорируем
    }
  }
}

function showHighlightPopoverCard(
  rendition: Rendition,
  opts: {
    type: "word" | "quote";
    title: string;
    translationOrQuote: string;
    exampleOrDate: string;
    speakWord?: string;
    targetFilePath: string;
    lineNumber: number;
  }
) {
  closeActiveHighlightPopover();

  const hostEl =
    (document.querySelector(".view-content.my-epub") as HTMLElement | null) ||
    document.body;

  const cardEl = hostEl.createDiv({
    cls:
      "my-epub-hl-card " +
      (opts.type === "word" ? "my-epub-hl-card-word" : "my-epub-hl-card-quote"),
  });
  cardEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  cardEl.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  cardEl.addEventListener("click", (e) => e.stopPropagation());

  const head = cardEl.createDiv("my-epub-hl-card-head");
  head.createSpan({
    cls: "my-epub-hl-card-title",
    text: opts.type === "word" ? `🇬🇧 ${opts.title}` : `💬 ${opts.title}`,
  });

  const closeBtn = head.createEl("button", {
    cls: "my-epub-hl-card-close",
    text: "✕",
    attr: { type: "button", "aria-label": "Закрыть карточку" },
  });
  closeBtn.onclick = () => closeActiveHighlightPopover();

  const mainBody = cardEl.createDiv("my-epub-hl-card-body");
  mainBody.setText(opts.translationOrQuote);

  if (opts.exampleOrDate) {
    cardEl.createDiv({
      cls: "my-epub-hl-card-example",
      text: opts.exampleOrDate,
    });
  }

  const actions = cardEl.createDiv("my-epub-hl-card-actions");

  if (opts.speakWord) {
    const wordToSpeak = opts.speakWord;
    const ttsBtn = actions.createEl("button", {
      cls: "my-epub-hl-card-btn",
      text: "🔊 Озвучить",
      attr: { type: "button", "aria-label": "Озвучить слово" },
    });
    ttsBtn.onclick = () => speakEnglishText(wordToSpeak);
  }

  const openLineBtn = actions.createEl("button", {
    cls: "mod-cta my-epub-hl-card-btn",
    text: `📄 Перейти в карточку (стр. ${opts.lineNumber})`,
    attr: { type: "button" },
  });
  openLineBtn.onclick = () => {
    closeActiveHighlightPopover();
    void openVaultFileAtLine(activeAnnotationsApp, opts.targetFilePath, opts.lineNumber);
  };

  const cleanupTargets: Array<() => void> = [];
  const onOutsideTap = (ev: Event) => {
    const target = ev.target as Node | null;
    if (target && cardEl.contains(target)) return;
    closeActiveHighlightPopover();
  };

  const timerId = window.setTimeout(() => {
    document.addEventListener("pointerdown", onOutsideTap, true);
    document.addEventListener("touchstart", onOutsideTap, { capture: true, passive: true });
    cleanupTargets.push(() => {
      document.removeEventListener("pointerdown", onOutsideTap, true);
      document.removeEventListener("touchstart", onOutsideTap, true);
    });

    try {
      const contentsList: any[] = (rendition as any)?.getContents?.() || [];
      for (const c of contentsList) {
        const doc: Document | undefined = c?.document;
        if (doc) {
          doc.addEventListener("pointerdown", onOutsideTap, true);
          doc.addEventListener("touchstart", onOutsideTap, { capture: true, passive: true });
          cleanupTargets.push(() => {
            doc.removeEventListener("pointerdown", onOutsideTap, true);
            doc.removeEventListener("touchstart", onOutsideTap, true);
          });
        }
      }
    } catch {
      // Игнорируем
    }
  }, 60);

  const onRelocatedClose = () => closeActiveHighlightPopover();
  try {
    rendition.on("relocated", onRelocatedClose);
  } catch {
    // Игнорируем
  }

  activeHighlightPopoverCleanup = () => {
    window.clearTimeout(timerId);
    for (const fn of cleanupTargets) {
      try {
        fn();
      } catch {
        // Игнорируем
      }
    }
    try {
      rendition.off?.("relocated", onRelocatedClose);
    } catch {
      // Игнорируем
    }
    cardEl.remove();
  };
}

export function applyHighlightsToRendition(
  rendition: Rendition | null,
  appliedCfis: Set<string>,
  words: BookWordEntry[],
  quotes: BookQuoteEntry[]
) {
  closeActiveHighlightPopover();
  if (!rendition || !rendition.annotations) return;

  for (const oldCfi of appliedCfis) {
    try {
      rendition.annotations.remove(oldCfi, "highlight");
    } catch {
      // Игнорируем
    }
  }
  appliedCfis.clear();

  for (const w of words) {
    if (!w.cfi || !w.cfi.startsWith("epubcfi(") || !w.cfi.includes(",")) continue;
    try {
      rendition.annotations.highlight(
        w.cfi,
        {},
        () => {
          speakEnglishText(w.word);
          showHighlightPopoverCard(rendition, {
            type: "word",
            title: w.word,
            translationOrQuote: w.back,
            exampleOrDate: w.example ? `«${w.example}»` : "",
            speakWord: w.word,
            targetFilePath: activeWordsFilePath,
            lineNumber: w.lineNumber,
          });
        },
        "my-epub-hl-word",
        highlightStyles("#599ed6", "0.28")
      );
      appliedCfis.add(w.cfi);
    } catch {
      // Игнорируем
    }
  }

  for (const q of quotes) {
    if (!q.cfi || !q.cfi.startsWith("epubcfi(") || !q.cfi.includes(",")) continue;
    try {
      rendition.annotations.highlight(
        q.cfi,
        {},
        () => {
          showHighlightPopoverCard(rendition, {
            type: "quote",
            title: "Цитата",
            translationOrQuote: `«${q.text}»`,
            exampleOrDate: q.date ? `Дата: ${q.date}` : "",
            targetFilePath: activeQuotesFilePath,
            lineNumber: q.lineNumber,
          });
        },
        "my-epub-hl-quote",
        highlightStyles("#e5a158", "0.30")
      );
      appliedCfis.add(q.cfi);
    } catch {
      // Игнорируем
    }
  }
}

// --- Быстрый перевод на лету без сохранения в словарь ---
export class QuickTranslateModal extends Modal {
  textToTranslate: string;
  onSaveToVocab: (word: string) => void;

  constructor(app: App, textToTranslate: string, onSaveToVocab: (word: string) => void) {
    super(app);
    (this as any).shouldRestoreSelection = false;
    this.textToTranslate = textToTranslate;
    this.onSaveToVocab = onSaveToVocab;
    configureTranslationCache(app);
  }

  safeClose() {
    try {
      (this as any).shouldRestoreSelection = false;
      this.close();
    } catch {
      // Игнорируем
    }
  }

  async onOpen() {
    (this as any).shouldRestoreSelection = false;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("my-epub-modal");

    const head = contentEl.createDiv("my-epub-word-head");
    head.createSpan({ cls: "my-epub-word-title", text: "🌐 Быстрый перевод" });

    const topRow = contentEl.createDiv("my-epub-modal-row");
    const input = topRow.createEl("input", {
      cls: "my-epub-input-en",
      type: "text",
      value: this.textToTranslate,
      placeholder: "Слово или фраза на английском…",
    });

    const speakBtn = topRow.createEl("button", {
      cls: "my-epub-modal-btn",
      text: "🔊",
      attr: { title: "Озвучить", "aria-label": "Озвучить слово" },
    });
    speakBtn.onclick = () => speakEnglishText(input.value);

    const trBtn = topRow.createEl("button", {
      cls: "my-epub-modal-btn",
      text: "Перевести",
    });

    const resultBox = contentEl.createDiv("my-epub-variants-box");
    resultBox.setText("⏳ Перевожу…");

    const footer = contentEl.createDiv("my-epub-modal-row-end");
    const toVocabBtn = footer.createEl("button", {
      cls: "mod-cta my-epub-modal-btn",
      text: "+ Открыть в форме словаря",
    });
    toVocabBtn.onclick = () => {
      const currentVal = input.value.trim() || this.textToTranslate;
      this.safeClose();
      this.onSaveToVocab(currentVal);
    };

    let requestSeq = 0;
    let closed = false;
    const origOnClose = this.onClose.bind(this);
    this.onClose = () => {
      closed = true;
      origOnClose();
    };

    const runLookup = async () => {
      const q = input.value.trim();
      if (!q) return;
      const mySeq = ++requestSeq;
      resultBox.empty();
      resultBox.setText("⏳ Перевожу…");
      try {
        const groups: TranslationGroup[] = await fetchTranslations(q);
        if (closed || mySeq !== requestSeq) return;
        resultBox.empty();
        if (!groups.length) {
          resultBox.setText("Перевод не найден.");
          return;
        }
        for (const g of groups) {
          const row = resultBox.createDiv("my-epub-variant-row");
          row.createSpan({ cls: "my-epub-variant-pos", text: g.pos });
          row.createSpan({
            cls: "my-epub-quick-terms",
            text: g.terms.join(" · "),
          });
        }
      } catch (e: any) {
        if (closed || mySeq !== requestSeq) return;
        resultBox.empty();
        resultBox.setText("Ошибка перевода: " + (e?.message || e));
      }
    };

    trBtn.onclick = () => void runLookup();
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void runLookup();
      }
    };

    speakEnglishText(this.textToTranslate);
    await runLookup();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Вспомогательный ручной поиск по DOM секции, если item.find в epub.js недоступен
function manualSearchInSectionDom(
  sectionItem: any,
  query: string,
  maxNeeded: number
): Array<{ cfi: string; excerpt: string }> {
  const results: Array<{ cfi: string; excerpt: string }> = [];
  const doc: Document | undefined = sectionItem?.document;
  const body = doc?.body || doc?.documentElement;
  if (!doc || !body) return results;

  const qLower = query.toLowerCase();
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();

  while (node && results.length < maxNeeded) {
    const text = node.nodeValue || "";
    const textLower = text.toLowerCase();
    let fromIdx = 0;

    while (results.length < maxNeeded) {
      const matchPos = textLower.indexOf(qLower, fromIdx);
      if (matchPos === -1) break;
      fromIdx = matchPos + Math.max(1, qLower.length);

      try {
        const range = doc.createRange();
        range.setStart(node, matchPos);
        range.setEnd(node, Math.min(text.length, matchPos + query.length));
        const cfi =
          typeof sectionItem.cfiFromRange === "function"
            ? sectionItem.cfiFromRange(range)
            : typeof sectionItem.cfiFromElement === "function" && node.parentElement
              ? sectionItem.cfiFromElement(node.parentElement)
              : "";

        if (cfi) {
          const startSnippet = Math.max(0, matchPos - 45);
          const endSnippet = Math.min(text.length, matchPos + query.length + 55);
          const prefix = startSnippet > 0 ? "…" : "";
          const suffix = endSnippet < text.length ? "…" : "";
          const excerpt = `${prefix}${text.slice(startSnippet, endSnippet).replace(/\s+/g, " ").trim()}${suffix}`;
          results.push({ cfi, excerpt });
        }
      } catch {
        // Игнорируем ошибку построения CFI для узла
      }
    }
    node = walker.nextNode();
  }

  return results;
}

// --- Единое модальное окно навигации: 📑 Главы | 🔖 Закладки | 🎓 Слова и цитаты | 🔍 Поиск ---
export class BookNavModal extends Modal {
  book: Book | null;
  toc: NavItem[];
  bookmarks: BookmarkItem[];
  words: BookWordEntry[];
  quotes: BookQuoteEntry[];
  currentChapterLabel: string;
  currentPage: number | null;
  currentPct: number | null;
  onSelectToc: (href: string) => void;
  onJumpCfi: (cfi: string) => void;
  onToggleBookmark: () => BookmarkItem[];
  onDeleteBookmark: (cfi: string) => BookmarkItem[];
  activeTab: "toc" | "bookmarks" | "items" | "search" = "toc";
  itemsFilter = "";
  searchQuery = "";
  searchResults: BookSearchMatch[] = [];
  searchStatusText = "";
  isSearching = false;
  searchAbortSeq = 0;
  currentTocMarked = false;
  currentTocEl: HTMLElement | null = null;

  constructor(
    app: App,
    opts: {
      book?: Book | null;
      toc: NavItem[];
      bookmarks: BookmarkItem[];
      words: BookWordEntry[];
      quotes: BookQuoteEntry[];
      currentChapterLabel: string;
      currentPage: number | null;
      currentPct: number | null;
      onSelectToc: (href: string) => void;
      onJumpCfi: (cfi: string) => void;
      onToggleBookmark: () => BookmarkItem[];
      onDeleteBookmark: (cfi: string) => BookmarkItem[];
    }
  ) {
    super(app);
    (this as any).shouldRestoreSelection = false;
    this.book = opts.book ?? null;
    this.toc = opts.toc;
    this.bookmarks = opts.bookmarks;
    this.words = opts.words;
    this.quotes = opts.quotes;
    this.currentChapterLabel = opts.currentChapterLabel;
    this.currentPage = opts.currentPage;
    this.currentPct = opts.currentPct;
    this.onSelectToc = opts.onSelectToc;
    this.onJumpCfi = opts.onJumpCfi;
    this.onToggleBookmark = opts.onToggleBookmark;
    this.onDeleteBookmark = opts.onDeleteBookmark;
  }

  safeClose() {
    this.searchAbortSeq++;
    this.isSearching = false;
    try {
      (this as any).shouldRestoreSelection = false;
      this.close();
    } catch {
      // Игнорируем
    }
  }

  onOpen() {
    (this as any).shouldRestoreSelection = false;
    this.render();
  }

  resolveChapterNameForHref(rawHref: string): string {
    const cleanHref = (rawHref || "").split("#")[0] || "";
    if (!cleanHref || !this.toc) return "";
    const findInItems = (items: NavItem[]): string => {
      for (const it of items) {
        const itemHref = (it.href || "").split("#")[0] || "";
        if (
          itemHref &&
          (itemHref === cleanHref || cleanHref.endsWith(itemHref) || itemHref.endsWith(cleanHref))
        ) {
          return (it.label || "").trim();
        }
        if (it.subitems && it.subitems.length > 0) {
          const sub = findInItems(it.subitems);
          if (sub) return sub;
        }
      }
      return "";
    };
    return findInItems(this.toc);
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("my-epub-toc-modal");

    const tabsRow = contentEl.createDiv("my-epub-nav-tabs");
    const totalItems = this.words.length + this.quotes.length;

    const tabs: Array<{ id: "toc" | "bookmarks" | "items" | "search"; label: string }> = [
      { id: "toc", label: "📑 Главы" },
      { id: "bookmarks", label: `🔖 Закладки (${this.bookmarks.length})` },
      { id: "items", label: `🎓 Слова (${totalItems})` },
      { id: "search", label: "🔍 Поиск" },
    ];

    for (const t of tabs) {
      const btn = tabsRow.createEl("button", {
        cls: "my-epub-nav-tab" + (this.activeTab === t.id ? " is-active" : ""),
        text: t.label,
      });
      btn.onclick = () => {
        if (this.activeTab === "search" && t.id !== "search") {
          this.searchAbortSeq++;
          this.isSearching = false;
        }
        this.activeTab = t.id;
        this.render();
      };
    }

    if (this.activeTab === "items") {
      this.renderItemsTab(contentEl);
      return;
    }

    if (this.activeTab === "search") {
      this.renderSearchTab(contentEl);
      return;
    }

    const body = contentEl.createDiv("my-epub-toc-list");

    if (this.activeTab === "toc") {
      if (!this.toc || this.toc.length === 0) {
        body.createDiv({ cls: "my-epub-toc-empty", text: "В этой книге нет оглавления." });
        return;
      }
      this.currentTocMarked = false;
      this.currentTocEl = null;
      this.renderTocItems(body, this.toc, 0);
      const target = this.currentTocEl as HTMLElement | null;
      if (target) {
        window.setTimeout(() => target.scrollIntoView({ block: "center" }), 0);
      }
      return;
    }

    // Закладки
    const addRow = body.createDiv("my-epub-bm-top");
    const pageStr = this.currentPage
      ? `стр. ${this.currentPage} (${this.currentPct ?? 0}%)`
      : "текущая страница";
    const addBmBtn = addRow.createEl("button", {
      cls: "mod-cta my-epub-modal-btn",
      text: `🔖 Сохранить закладку на ${pageStr}`,
    });
    addBmBtn.onclick = () => {
      this.bookmarks = this.onToggleBookmark();
      this.render();
    };

    if (this.bookmarks.length === 0) {
      body.createDiv({
        cls: "my-epub-toc-empty",
        text: "Закладок пока нет. Нажми кнопку выше, чтобы отметить текущую страницу.",
      });
      return;
    }

    const sorted = [...this.bookmarks].sort((a, b) => a.page - b.page);
    for (const bm of sorted) {
      const row = body.createDiv("my-epub-bm-item");
      const left = row.createDiv("my-epub-bm-main");
      left.createDiv({
        cls: "my-epub-bm-title",
        text: `🔖 Стр. ${bm.page} · ${bm.pct}%${bm.label ? " — " + bm.label : ""}`,
      });
      left.createDiv({ cls: "my-epub-bm-sub", text: bm.createdAt });
      left.onclick = () => {
        this.onJumpCfi(bm.cfi);
        this.safeClose();
      };

      const delBtn = row.createEl("button", {
        cls: "my-epub-bm-del",
        text: "✕",
        attr: { title: "Удалить закладку", "aria-label": "Удалить закладку" },
      });
      delBtn.onclick = (e) => {
        e.stopPropagation();
        this.bookmarks = this.onDeleteBookmark(bm.cfi);
        this.render();
      };
    }
  }

  // C1: Вкладка «🔍 Поиск» по главам книги через book.spine.each и item.find(query) (с фолбэком на item.load + DOM)
  renderSearchTab(parent: HTMLElement) {
    const controlsRow = parent.createDiv("my-epub-search-controls");
    const searchInput = controlsRow.createEl("input", {
      cls: "my-epub-nav-search my-epub-search-input",
      type: "search",
      value: this.searchQuery,
      placeholder: "Поиск фразы или слова по тексту книги…",
    });

    const runBtn = controlsRow.createEl("button", {
      cls: "mod-cta my-epub-modal-btn",
      text: "Найти",
    });

    const cancelBtn = controlsRow.createEl("button", {
      cls: "my-epub-modal-btn",
      text: "Стоп",
    });
    cancelBtn.style.display = this.isSearching ? "inline-flex" : "none";

    const statusEl = parent.createDiv({
      cls: "my-epub-search-status",
      text: this.searchStatusText,
    });
    statusEl.style.display = this.searchStatusText ? "block" : "none";

    const listEl = parent.createDiv("my-epub-toc-list");

    const drawResults = () => {
      listEl.empty();
      statusEl.setText(this.searchStatusText);
      statusEl.style.display = this.searchStatusText ? "block" : "none";
      cancelBtn.style.display = this.isSearching ? "inline-flex" : "none";
      runBtn.disabled = this.isSearching;

      if (!this.isSearching && this.searchResults.length === 0 && this.searchQuery.trim()) {
        listEl.createDiv({
          cls: "my-epub-toc-empty",
          text: this.searchStatusText ? "" : "Совпадений не найдено.",
        });
        return;
      }

      for (const item of this.searchResults) {
        const row = listEl.createDiv("my-epub-bm-item");
        const main = row.createDiv("my-epub-bm-main");
        if (item.chapterLabel) {
          main.createDiv({
            cls: "my-epub-search-chapter",
            text: `📑 ${item.chapterLabel}`,
          });
        }
        main.createDiv({
          cls: "my-epub-bm-title",
          text: item.excerpt,
        });
        main.onclick = () => {
          this.onJumpCfi(item.cfi);
          this.safeClose();
        };
      }
    };

    const startSearch = async () => {
      const q = searchInput.value.trim();
      this.searchQuery = q;
      if (q.length < 2) {
        this.searchStatusText = "Введи минимум 2 символа для поиска.";
        this.searchResults = [];
        drawResults();
        return;
      }
      if (!this.book || !this.book.spine) {
        this.searchStatusText = "Книга ещё не загружена.";
        drawResults();
        return;
      }

      const mySeq = ++this.searchAbortSeq;
      this.isSearching = true;
      this.searchResults = [];
      this.searchStatusText = "Подготовка к поиску…";
      drawResults();

      const spineItems: any[] = [];
      const spineAny: any = this.book.spine;
      if (typeof spineAny.each === "function") {
        spineAny.each((item: any) => spineItems.push(item));
      } else if (Array.isArray(spineAny.spineItems)) {
        spineItems.push(...spineAny.spineItems);
      }

      const totalSections = spineItems.length;

      for (let i = 0; i < totalSections; i++) {
        if (mySeq !== this.searchAbortSeq) return;
        const section = spineItems[i];
        if (!section) continue;

        this.searchStatusText = `Ищу в секции ${i + 1} из ${totalSections}… (найдено: ${this.searchResults.length})`;
        statusEl.setText(this.searchStatusText);
        statusEl.style.display = "block";

        // Уступаем поток UI между главами, чтобы кнопка «Стоп» оставалась отзывчивой
        await new Promise<void>((r) => window.setTimeout(r, 0));
        if (mySeq !== this.searchAbortSeq) return;

        let loadedHere = false;
        try {
          if (!section.document && typeof section.load === "function") {
            await section.load(this.book.load.bind(this.book));
            loadedHere = true;
          }

          if (mySeq !== this.searchAbortSeq) {
            if (loadedHere) section.unload?.();
            return;
          }

          const needed = MAX_SEARCH_RESULTS - this.searchResults.length;
          let sectionMatches: Array<{ cfi: string; excerpt: string }> = [];

          // Проверяем наличие item.find в используемой версии epub.js
          if (typeof section.find === "function") {
            try {
              const rawFound = section.find(q);
              if (Array.isArray(rawFound)) {
                sectionMatches = rawFound
                  .filter((m: any) => m && typeof m.cfi === "string" && m.cfi.length > 0)
                  .slice(0, needed)
                  .map((m: any) => ({
                    cfi: String(m.cfi),
                    excerpt: String(m.excerpt || "").replace(/\s+/g, " ").trim(),
                  }));
              }
            } catch {
              sectionMatches = manualSearchInSectionDom(section, q, needed);
            }
          } else {
            sectionMatches = manualSearchInSectionDom(section, q, needed);
          }

          if (sectionMatches.length > 0) {
            const chapterLabel =
              this.resolveChapterNameForHref(section.href || "") || `Раздел ${i + 1}`;
            for (const m of sectionMatches) {
              if (this.searchResults.length >= MAX_SEARCH_RESULTS) break;
              this.searchResults.push({
                cfi: m.cfi,
                excerpt: m.excerpt || q,
                chapterLabel,
              });
            }
            drawResults();
          }
        } catch {
          // Пропускаем секцию при ошибке чтения
        } finally {
          if (loadedHere) {
            try {
              section.unload?.();
            } catch {
              // Игнорируем
            }
          }
        }

        if (this.searchResults.length >= MAX_SEARCH_RESULTS) {
          break;
        }
      }

      if (mySeq !== this.searchAbortSeq) return;
      this.isSearching = false;
      const hitLimit = this.searchResults.length >= MAX_SEARCH_RESULTS;
      this.searchStatusText =
        this.searchResults.length > 0
          ? `Найдено совпадений: ${this.searchResults.length}${hitLimit ? ` (показаны первые ${MAX_SEARCH_RESULTS})` : ""}`
          : "Совпадений не найдено.";
      drawResults();
    };

    cancelBtn.onclick = () => {
      this.searchAbortSeq++;
      this.isSearching = false;
      this.searchStatusText = `Поиск остановлен (найдено: ${this.searchResults.length}).`;
      drawResults();
    };

    runBtn.onclick = () => void startSearch();
    searchInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void startSearch();
      }
    };

    drawResults();
    if (!this.isSearching) {
      window.setTimeout(() => searchInput.focus(), 30);
    }
  }

  renderItemsTab(parent: HTMLElement) {
    if (this.words.length === 0 && this.quotes.length === 0) {
      const empty = parent.createDiv("my-epub-toc-list");
      empty.createDiv({
        cls: "my-epub-toc-empty",
        text: "Из этой книги пока не выписано ни одного слова или цитаты.",
      });
      return;
    }

    const search = parent.createEl("input", {
      cls: "my-epub-nav-search",
      type: "search",
      value: this.itemsFilter,
      placeholder: "Фильтр по словам и цитатам…",
    });
    const listEl = parent.createDiv("my-epub-toc-list");

    const draw = () => {
      listEl.empty();
      const q = this.itemsFilter.trim().toLowerCase();
      const words = q
        ? this.words.filter((w) =>
            `${w.word} ${w.back} ${w.example}`.toLowerCase().includes(q)
          )
        : this.words;
      const quotes = q
        ? this.quotes.filter((x) => x.text.toLowerCase().includes(q))
        : this.quotes;

      if (words.length === 0 && quotes.length === 0) {
        listEl.createDiv({ cls: "my-epub-toc-empty", text: "Ничего не найдено." });
        return;
      }

      if (words.length > 0) {
        listEl.createDiv({
          cls: "my-epub-nav-group-title",
          text: `🇬🇧 Выписанные слова (${words.length})`,
        });
        for (const w of words) this.renderWordRow(listEl, w);
      }

      if (quotes.length > 0) {
        listEl.createDiv({
          cls: "my-epub-nav-group-title",
          text: `💬 Выписанные цитаты (${quotes.length})`,
        });
        for (const qt of quotes) this.renderQuoteRow(listEl, qt);
      }
    };

    search.addEventListener("input", () => {
      this.itemsFilter = search.value;
      draw();
    });
    draw();
  }

  renderWordRow(container: HTMLElement, w: BookWordEntry) {
    const row = container.createDiv("my-epub-bm-item");
    const left = row.createDiv("my-epub-bm-main");
    left.createDiv({ cls: "my-epub-bm-title", text: `${w.word} — ${w.back}` });
    if (w.example) {
      left.createDiv({ cls: "my-epub-bm-sub", text: w.example });
    }
    left.onclick = () => {
      if (w.cfi) {
        this.onJumpCfi(w.cfi);
        this.safeClose();
      } else {
        speakEnglishText(w.word);
      }
    };

    const rightBtns = row.createDiv("my-epub-bm-actions");
    const ttsBtn = rightBtns.createEl("button", {
      cls: "my-epub-bm-del",
      text: "🔊",
      attr: { title: "Озвучить слово", "aria-label": "Озвучить слово" },
    });
    ttsBtn.onclick = (e) => {
      e.stopPropagation();
      speakEnglishText(w.word);
    };

    const cfi = w.cfi;
    if (cfi) {
      const jumpBtn = rightBtns.createEl("button", {
        cls: "my-epub-bm-del",
        text: "📖",
        attr: { title: "Перейти к месту в книге", "aria-label": "Перейти к месту в книге" },
      });
      jumpBtn.onclick = (e) => {
        e.stopPropagation();
        this.onJumpCfi(cfi);
        this.safeClose();
      };
    }
  }

  renderQuoteRow(container: HTMLElement, q: BookQuoteEntry) {
    const row = container.createDiv("my-epub-bm-item");
    const left = row.createDiv("my-epub-bm-main");
    left.createDiv({ cls: "my-epub-bm-title", text: `«${q.text}»` });
    if (q.date) {
      left.createDiv({ cls: "my-epub-bm-sub", text: q.date });
    }
    const cfi = q.cfi;
    if (cfi) {
      left.onclick = () => {
        this.onJumpCfi(cfi);
        this.safeClose();
      };
    }
  }

  renderTocItems(container: HTMLElement, items: NavItem[], level: number) {
    const current = (this.currentChapterLabel || "").trim().toLowerCase();
    for (const item of items) {
      const label = (item.label || "Без названия").trim();
      const row = container.createDiv({ cls: "my-epub-toc-item" });
      row.style.paddingLeft = `${0.75 + level * 1.25}rem`;
      row.setText(label);

      if (!this.currentTocMarked && current && label.toLowerCase() === current) {
        row.addClass("is-current");
        this.currentTocMarked = true;
        this.currentTocEl = row;
      }

      row.onclick = () => {
        this.onSelectToc(item.href);
        this.safeClose();
      };
      if (item.subitems && item.subitems.length > 0) {
        this.renderTocItems(container, item.subitems, level + 1);
      }
    }
  }

  onClose() {
    this.searchAbortSeq++;
    this.isSearching = false;
    this.contentEl.empty();
  }
}