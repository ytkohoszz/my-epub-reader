import { App, Modal, Notice, TFile } from "obsidian";
import { NavItem, Rendition } from "epubjs";
import {
  BookNoteInfo,
  EXAMPLE_SEP,
  TranslationGroup,
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

export async function loadBookAnnotationsFromVault(
  app: App,
  linkedBook: BookNoteInfo | null,
  wordsFilePath: string,
  quotesFilePath: string
): Promise<{ words: BookWordEntry[]; quotes: BookQuoteEntry[] }> {
  if (!linkedBook) return { words: [], quotes: [] };

  const words: BookWordEntry[] = [];
  const quotes: BookQuoteEntry[] = [];

  const wordsFile = resolveVaultFile(app, wordsFilePath || "Words Cards");
  if (wordsFile) {
    try {
      // cachedRead не перечитывает большой файл с диска при каждом обновлении
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

  const quotesFile = resolveVaultFile(app, quotesFilePath || "Знания/Цитаты из книг.md");
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

// В тёмной теме multiply делает подсветку невидимой, поэтому там используем обычное наложение
function highlightStyles(fill: string, opacity: string): Record<string, string> {
  const isDark = document.body.classList.contains("theme-dark");
  return {
    fill,
    "fill-opacity": isDark ? "0.38" : opacity,
    "mix-blend-mode": isDark ? "normal" : "multiply",
  };
}

export function applyHighlightsToRendition(
  rendition: Rendition | null,
  appliedCfis: Set<string>,
  words: BookWordEntry[],
  quotes: BookQuoteEntry[]
) {
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
          new Notice(`🇬🇧 ${w.word} — ${w.back}`, 4500);
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
          const shortText = q.text.length > 140 ? q.text.slice(0, 140) + "…" : q.text;
          new Notice(`💬 «${shortText}»`, 5000);
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
      attr: { title: "Озвучить" },
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

    // Номер запроса: устаревший ответ не перезапишет результат нового
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

// --- Единое модальное окно навигации: 📑 Главы | 🔖 Закладки | 🎓 Слова и цитаты ---
export class BookNavModal extends Modal {
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
  activeTab: "toc" | "bookmarks" | "items" = "toc";
  itemsFilter = "";
  currentTocMarked = false;
  currentTocEl: HTMLElement | null = null;

  constructor(
    app: App,
    opts: {
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

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("my-epub-toc-modal");

    const tabsRow = contentEl.createDiv("my-epub-nav-tabs");
    const totalItems = this.words.length + this.quotes.length;

    const tabs: Array<{ id: "toc" | "bookmarks" | "items"; label: string }> = [
      { id: "toc", label: "📑 Главы" },
      { id: "bookmarks", label: `🔖 Закладки (${this.bookmarks.length})` },
      { id: "items", label: `🎓 Слова и цитаты (${totalItems})` },
    ];

    for (const t of tabs) {
      const btn = tabsRow.createEl("button", {
        cls: "my-epub-nav-tab" + (this.activeTab === t.id ? " is-active" : ""),
        text: t.label,
      });
      btn.onclick = () => {
        this.activeTab = t.id;
        this.render();
      };
    }

    if (this.activeTab === "items") {
      this.renderItemsTab(contentEl);
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
        attr: { title: "Удалить закладку" },
      });
      delBtn.onclick = (e) => {
        e.stopPropagation();
        this.bookmarks = this.onDeleteBookmark(bm.cfi);
        this.render();
      };
    }
  }

  // Вкладка слов и цитат: поле поиска создаётся один раз, список перерисовывается отдельно
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
      attr: { title: "Озвучить слово" },
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
        attr: { title: "Перейти к месту в книге" },
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

      // Отмечаем первую подходящую главу как текущую
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
    this.contentEl.empty();
  }
}