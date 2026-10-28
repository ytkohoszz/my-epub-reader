import {
  App,
  FileView,
  Menu,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import ePub, { Book, NavItem, Rendition } from "epubjs";
import {
  AddQuoteModal,
  AddWordModal,
  BookLinkModal,
  BookNoteInfo,
  JumpToPageModal,
  cleanSelectedQuote,
  cleanSelectedWord,
  extractSentenceFromSelection,
  findMatchingBookNotes,
  getTodayISO,
  loadBookNotesFromVault,
} from "./modals";
import {
  BookNavModal,
  BookQuoteEntry,
  BookWordEntry,
  BookmarkItem,
  QuickTranslateModal,
  applyHighlightsToRendition,
  loadBookAnnotationsFromVault,
} from "./highlights";

const VIEW_TYPE = "my-epub-view";
const MAX_CACHED_BOOKS = 15;
const YAML_SYNC_DEBOUNCE_MS = 2000;

type ThemeMode = "auto" | "sepia";
type FontFamily = "default" | "serif" | "sans" | "mono";
type PageAnimation = "slide" | "fade" | "none";
type BarPosition = "bottom" | "top";
type SpreadMode = "none" | "auto";

interface LocationCacheEntry {
  sig: string;
  locations: string;
  updatedAt: number;
}

interface NavHistoryItem {
  cfi: string;
  page: number;
}

export interface Settings {
  progress: Record<string, string>;
  fontSize: number;
  themeMode?: ThemeMode;
  fontFamily?: FontFamily;
  lineHeight?: number;
  pageAnimation?: PageAnimation;
  barPosition?: BarPosition;
  spreadMode?: SpreadMode;
  desktopWidthPct?: number;
  locationsCache?: Record<string, LocationCacheEntry>;
  bookmarks?: Record<string, BookmarkItem[]>;
  booksFolder?: string;
  wordsFilePath?: string;
  quotesFilePath?: string;
}

const DEFAULTS: Settings = {
  progress: {},
  fontSize: 120,
  themeMode: "auto",
  fontFamily: "serif",
  lineHeight: 1.6,
  pageAnimation: "slide",
  barPosition: "bottom",
  spreadMode: "none",
  desktopWidthPct: 85,
  locationsCache: {},
  bookmarks: {},
  booksFolder: "Знания/Книги",
  wordsFilePath: "Words Cards",
  quotesFilePath: "Знания/Цитаты из книг.md",
};

function migrateSettings(raw: any): Settings {
  const s: Settings = Object.assign({}, DEFAULTS, raw || {});
  if (!s.progress || typeof s.progress !== "object") s.progress = {};
  if (typeof s.fontSize !== "number" || isNaN(s.fontSize)) s.fontSize = DEFAULTS.fontSize;
  if (!s.locationsCache || typeof s.locationsCache !== "object") s.locationsCache = {};
  if (!s.bookmarks || typeof s.bookmarks !== "object") s.bookmarks = {};
  if (!s.booksFolder || typeof s.booksFolder !== "string") s.booksFolder = DEFAULTS.booksFolder;
  if (!s.wordsFilePath || typeof s.wordsFilePath !== "string") s.wordsFilePath = DEFAULTS.wordsFilePath;
  if (!s.quotesFilePath || typeof s.quotesFilePath !== "string") s.quotesFilePath = DEFAULTS.quotesFilePath;
  if (s.spreadMode !== "auto" && s.spreadMode !== "none") s.spreadMode = "none";
  return s;
}

const FONT_MAP: Record<FontFamily, string> = {
  default: "inherit",
  serif: "Georgia, 'Times New Roman', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

export class EpubView extends FileView {
  plugin: MyEpubPlugin;
  book: Book | null = null;
  rendition: Rendition | null = null;
  wrapEl!: HTMLElement;
  boxEl!: HTMLElement;
  barEl!: HTMLElement;
  fsBarEl!: HTMLElement;
  fsInfoEl!: HTMLElement;
  backPillEl!: HTMLElement;
  backPillTextEl!: HTMLElement;
  info!: HTMLElement;
  themeBtn!: HTMLButtonElement;
  fsBtn!: HTMLButtonElement;
  quickTrBtn!: HTMLButtonElement;
  addWordBtn!: HTMLButtonElement;
  addQuoteBtn!: HTMLButtonElement;
  fsQuickTrBtn!: HTMLButtonElement;
  fsAddWordBtn!: HTMLButtonElement;
  fsAddQuoteBtn!: HTMLButtonElement;
  resizeObserver: ResizeObserver | null = null;
  resizeTimer: number | null = null;
  animTimer: number | null = null;
  yamlSyncTimer: number | null = null;
  isFullscreen = false;
  lastGestureTime = 0;

  stableCfi: string | null = null;
  isResizing = false;
  isInitialLoadDone = false;
  ExplicitCfiJumpPending = false;
  lastBoxWidth = 0;
  lastBoxHeight = 0;
  loadId = 0;
  cleanupListeners: Array<() => void> = [];

  // Стек возврата со сносок, оглавления и быстрых переходов
  navHistory: NavHistoryItem[] = [];

  capturedWord = "";
  capturedQuote = "";
  capturedCfi: string | null = null;
  extractedSentence = "";
  lastSelectionAt = 0;
  linkedBookNote: BookNoteInfo | null = null;
  bookAuthorMeta = "";
  bookTitleMeta = "";

  bookWords: BookWordEntry[] = [];
  bookQuotes: BookQuoteEntry[] = [];
  appliedHighlightCfis = new Set<string>();

  currentPageNum: number | null = null;
  totalPagesNum: number | null = null;
  currentProgressPct: number | null = null;
  chapterPageCurrent: number | null = null;
  chapterPageTotal: number | null = null;
  currentChapterTitle = "";
  pendingYamlSync = false;

  constructor(leaf: WorkspaceLeaf, plugin: MyEpubPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file?.basename ?? "EPUB"; }
  canAcceptExtension(ext: string) { return ext === "epub"; }

  async onLoadFile(file: TFile) {
    await this.flushYamlProgress();
    this.cleanupView();
    const currentLoadId = ++this.loadId;

    await this.plugin.reloadSettingsFromDisk();
    if (currentLoadId !== this.loadId) return;

    const root = this.contentEl;
    root.empty();
    root.addClass("my-epub");
    root.setAttr("tabindex", "-1");

    this.stableCfi = this.plugin.settings.progress[file.path] || null;
    this.isResizing = false;
    this.isInitialLoadDone = false;
    this.lastBoxWidth = 0;
    this.lastBoxHeight = 0;
    this.navHistory = [];
    this.capturedWord = "";
    this.capturedQuote = "";
    this.capturedCfi = null;
    this.extractedSentence = "";
    this.lastSelectionAt = 0;
    this.linkedBookNote = null;
    this.bookTitleMeta = file.basename;
    this.bookAuthorMeta = "";
    this.bookWords = [];
    this.bookQuotes = [];
    this.appliedHighlightCfis.clear();
    this.currentPageNum = null;
    this.totalPagesNum = null;
    this.currentProgressPct = null;
    this.chapterPageCurrent = null;
    this.chapterPageTotal = null;
    this.currentChapterTitle = "";
    this.pendingYamlSync = false;

    this.wrapEl = root.createDiv("my-epub-wrap");
    this.boxEl = this.wrapEl.createDiv("my-epub-box");
    this.applyDesktopWidth(false);
    this.applySpreadClass();

    // Плавающая капсула возврата после клика по сноске / переходу по оглавлению
    this.backPillEl = root.createDiv("my-epub-back-pill");
    this.backPillTextEl = this.backPillEl.createSpan({
      cls: "my-epub-back-pill-text",
      text: "↩ Назад",
    });
    const backDismissBtn = this.backPillEl.createSpan({
      cls: "my-epub-back-pill-close",
      text: "✕",
      attr: { title: "Скрыть кнопку возврата и остаться здесь" },
    });
    this.backPillTextEl.onclick = (e) => {
      e.stopPropagation();
      void this.popNavHistory();
    };
    backDismissBtn.onclick = (e) => {
      e.stopPropagation();
      this.navHistory = [];
      this.updateBackPillState();
      this.requestYamlProgressSync();
    };
    this.updateBackPillState();

    // Мини-пульт для полноэкранного режима
    this.fsBarEl = root.createDiv("my-epub-fs-bar");
    const fsPrev = this.fsBarEl.createEl("button", { cls: "my-epub-fs-btn", text: "◀" });
    this.fsInfoEl = this.fsBarEl.createSpan({ cls: "my-epub-fs-info", text: "… · ⛶" });
    this.fsQuickTrBtn = this.fsBarEl.createEl("button", {
      cls: "my-epub-fs-btn my-epub-word-btn",
      text: "🌐",
      attr: { "aria-label": "Быстрый перевод" },
    });
    this.fsAddWordBtn = this.fsBarEl.createEl("button", {
      cls: "my-epub-fs-btn my-epub-word-btn",
      text: "+ Слово",
    });
    this.fsAddQuoteBtn = this.fsBarEl.createEl("button", {
      cls: "my-epub-fs-btn my-epub-word-btn",
      text: "💬",
    });
    const fsNext = this.fsBarEl.createEl("button", { cls: "my-epub-fs-btn", text: "▶" });

    fsPrev.onclick = (e) => { e.stopPropagation(); this.turnPage("prev"); };
    fsNext.onclick = (e) => { e.stopPropagation(); this.turnPage("next"); };
    this.fsInfoEl.onclick = (e) => { e.stopPropagation(); this.toggleFullscreen(false); };
    this.bindActionButton(this.fsQuickTrBtn, () => this.handleQuickTranslateClick());
    this.bindActionButton(this.fsAddWordBtn, () => this.handleAddWordClick());
    this.bindActionButton(this.fsAddQuoteBtn, () => this.handleAddQuoteClick());

    // Основная панель управления
    this.barEl = root.createDiv("my-epub-bar");
    this.applyBarPosition();

    const leftGroup = this.barEl.createDiv("my-epub-group");
    const prev = leftGroup.createEl("button", { cls: "my-epub-btn", text: "◀" });
    const tocBtn = leftGroup.createEl("button", { cls: "my-epub-btn", text: "📑" });
    tocBtn.setAttr("aria-label", "Оглавление, закладки и выписанные слова");
    const smaller = leftGroup.createEl("button", { cls: "my-epub-btn", text: "A−" });

    this.info = this.barEl.createDiv({
      cls: "my-epub-info",
      text: "загрузка…",
      attr: { title: "Нажми для быстрого перехода к странице" },
    });
    this.info.onclick = () => this.openJumpModal();

    const rightGroup = this.barEl.createDiv("my-epub-group");
    this.quickTrBtn = rightGroup.createEl("button", {
      cls: "my-epub-btn my-epub-word-btn",
      text: "🌐",
      attr: { "aria-label": "Быстрый перевод без записи в словарь" },
    });
    this.addWordBtn = rightGroup.createEl("button", {
      cls: "my-epub-btn my-epub-word-btn",
      text: "+ Слово",
    });
    this.addQuoteBtn = rightGroup.createEl("button", {
      cls: "my-epub-btn my-epub-word-btn",
      text: "💬",
      attr: { "aria-label": "Добавить цитату" },
    });
    this.bindActionButton(this.quickTrBtn, () => this.handleQuickTranslateClick());
    this.bindActionButton(this.addWordBtn, () => this.handleAddWordClick());
    this.bindActionButton(this.addQuoteBtn, () => this.handleAddQuoteClick());
    this.updateSelectionButtonsState();

    const bigger = rightGroup.createEl("button", { cls: "my-epub-btn", text: "A+" });
    const fontBtn = rightGroup.createEl("button", { cls: "my-epub-btn", text: "🔤" });
    fontBtn.setAttr("aria-label", "Вид, шрифт, разворот и привязка книги");
    this.themeBtn = rightGroup.createEl("button", { cls: "my-epub-btn" });
    this.updateThemeBtnText();
    this.fsBtn = rightGroup.createEl("button", { cls: "my-epub-btn", text: "⛶" });
    this.fsBtn.setAttr("aria-label", "Полноэкранный режим");
    const next = rightGroup.createEl("button", { cls: "my-epub-btn", text: "▶" });

    try {
      const data = await this.app.vault.readBinary(file);
      if (currentLoadId !== this.loadId) return;

      if (!data || data.byteLength === 0) {
        throw new Error("Файл книги пуст (0 байт).");
      }

      this.book = ePub(data);
      const spreadMode = this.plugin.settings.spreadMode ?? "none";
      this.rendition = this.book.renderTo(this.boxEl, {
        width: "100%",
        height: "100%",
        flow: "paginated",
        spread: spreadMode,
      });

      this.applyStyles();
      this.setupGesturesAndSelection();

      prev.onclick = () => this.turnPage("prev");
      next.onclick = () => this.turnPage("next");
      smaller.onclick = () => this.setFont(-10);
      bigger.onclick = () => this.setFont(10);
      this.themeBtn.onclick = () => this.toggleThemeMode();
      this.fsBtn.onclick = () => this.toggleFullscreen();
      tocBtn.onclick = () => this.openToc();
      fontBtn.onclick = (e) => this.openTypographyMenu(e);

      this.registerEvent(
        this.app.workspace.on("css-change", () => this.applyStyles())
      );
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", () => this.plugin.syncGlobalBodyClasses())
      );

      this.rendition.on("relocated", (loc: any) => this.onRelocated(file, loc));

      try {
        await this.rendition.display(this.stableCfi || undefined);
      } catch {
        this.stableCfi = null;
        await this.rendition.display();
      }

      if (currentLoadId !== this.loadId) return;

      this.lastBoxWidth = this.boxEl.clientWidth;
      this.lastBoxHeight = this.boxEl.clientHeight;
      this.setupResizeObserver();

      await this.book.ready;
      if (currentLoadId !== this.loadId || !this.book) return;

      try {
        const meta: any = await (this.book as any).loaded?.metadata;
        if (meta?.title) this.bookTitleMeta = String(meta.title).trim();
        if (meta?.creator) this.bookAuthorMeta = String(meta.creator).trim();
      } catch {
        // Игнорируем
      }

      this.trySilentResolveLinkedBookNote(file);
      await this.refreshBookHighlights();

      await this.loadOrGenerateLocations(file, currentLoadId);
      if (currentLoadId !== this.loadId || !this.rendition) return;

      const cur: any = this.rendition.currentLocation();
      if (cur?.start?.cfi) {
        this.captureChapterMetricsFromLoc(cur);
        this.stableCfi = cur.start.cfi;
        this.updateProgressLabels(cur.start.cfi);
      }

      await this.reconcilePositionWithBookNote(file, currentLoadId);
      if (currentLoadId !== this.loadId) return;

      this.isInitialLoadDone = true;
      this.ExplicitCfiJumpPending = false;
      this.requestYamlProgressSync();
    } catch (err: any) {
      if (currentLoadId !== this.loadId) return;
      console.error("MyEpubPlugin error loading file:", err);
      this.showError(file.name, err?.message || "Не удалось прочитать файл EPUB.");
    }
  }

  // Сохраняет текущую позицию в стек возврата перед прыжком по сноске / оглавлению
  pushNavHistory() {
    if (!this.stableCfi || !this.currentPageNum) return;
    const last = this.navHistory[this.navHistory.length - 1];
    if (last && last.page === this.currentPageNum) return;
    this.navHistory.push({
      cfi: this.stableCfi,
      page: this.currentPageNum,
    });
    if (this.navHistory.length > 10) this.navHistory.shift();
    this.updateBackPillState();
  }

  async popNavHistory() {
    const prev = this.navHistory.pop();
    this.updateBackPillState();
    if (!prev) return;
    await this.jumpToCfi(prev.cfi, false);
  }

  updateBackPillState() {
    if (!this.backPillEl || !this.backPillTextEl) return;
    const last = this.navHistory[this.navHistory.length - 1];
    if (!last) {
      this.backPillEl.removeClass("is-visible");
      return;
    }
    this.backPillTextEl.setText(`↩ Назад к стр. ${last.page}`);
    this.backPillEl.addClass("is-visible");
  }

  captureChapterMetricsFromLoc(loc: any) {
    const disp = loc?.start?.displayed;
    if (disp && typeof disp.page === "number" && typeof disp.total === "number" && disp.total > 0) {
      this.chapterPageCurrent = disp.page;
      this.chapterPageTotal = disp.total;
    } else {
      this.chapterPageCurrent = null;
      this.chapterPageTotal = null;
    }

    const href: string = loc?.start?.href || "";
    if (href && this.book?.navigation?.toc) {
      const cleanHref = href.split("#")[0] || "";
      const found = this.findTocLabelByHref(this.book.navigation.toc, cleanHref);
      if (found) this.currentChapterTitle = found;
    }
  }

  findTocLabelByHref(items: NavItem[], cleanHref: string): string {
    for (const it of items) {
      const itemHref = (it.href || "").split("#")[0] || "";
      if (itemHref && (itemHref === cleanHref || cleanHref.endsWith(itemHref) || itemHref.endsWith(cleanHref))) {
        return (it.label || "").trim();
      }
      if (it.subitems && it.subitems.length > 0) {
        const subFound = this.findTocLabelByHref(it.subitems, cleanHref);
        if (subFound) return subFound;
      }
    }
    return "";
  }

  getChapterSummaryText(): string {
    const parts: string[] = [];
    if (this.currentChapterTitle) parts.push(`Глава: «${this.currentChapterTitle}»`);
    if (this.chapterPageCurrent !== null && this.chapterPageTotal !== null) {
      const left = Math.max(0, this.chapterPageTotal - this.chapterPageCurrent);
      parts.push(
        left === 0
          ? `последняя страница главы (${this.chapterPageCurrent}/${this.chapterPageTotal})`
          : `до конца главы: ${left} стр. (${this.chapterPageCurrent} из ${this.chapterPageTotal})`
      );
    }
    return parts.join(" · ");
  }

  applySpreadClass() {
    const isSpread = (this.plugin.settings.spreadMode ?? "none") === "auto";
    this.contentEl.toggleClass("my-epub-is-spread", isSpread);
  }

  applySpreadMode(mode: SpreadMode) {
    this.plugin.settings.spreadMode = mode;
    this.applySpreadClass();
    this.isResizing = true;
    try {
      this.rendition?.spread(mode);
    } catch {
      // Игнорируем
    }
    this.triggerResize(true);
  }

  async refreshBookHighlights() {
    if (!this.linkedBookNote) return;
    const { words, quotes } = await loadBookAnnotationsFromVault(
      this.app,
      this.linkedBookNote,
      this.plugin.settings.wordsFilePath || "Words Cards",
      this.plugin.settings.quotesFilePath || "Знания/Цитаты из книг.md"
    );
    this.bookWords = words;
    this.bookQuotes = quotes;
    applyHighlightsToRendition(
      this.rendition,
      this.appliedHighlightCfis,
      this.bookWords,
      this.bookQuotes
    );
  }

  toggleBookmarkOnCurrentPage(): BookmarkItem[] {
    if (!this.file || !this.stableCfi) return [];
    if (!this.plugin.settings.bookmarks) this.plugin.settings.bookmarks = {};
    const list = this.plugin.settings.bookmarks[this.file.path] ?? [];
    const page = this.currentPageNum ?? 1;
    const pct = this.currentProgressPct ?? 0;

    const existingIdx = list.findIndex((b) => b.page === page || b.cfi === this.stableCfi);
    if (existingIdx !== -1) {
      list.splice(existingIdx, 1);
      new Notice(`Закладка на стр. ${page} удалена`);
    } else {
      list.unshift({
        cfi: this.stableCfi,
        page,
        pct,
        label: this.currentChapterTitle || this.bookTitleMeta || this.file.basename,
        createdAt: getTodayISO(),
      });
      new Notice(`🔖 Добавлена закладка: стр. ${page} (${pct}%)`);
    }

    this.plugin.settings.bookmarks[this.file.path] = list;
    this.plugin.requestSaveSettings();
    this.updateProgressLabels(this.stableCfi);
    return list;
  }

  deleteBookmarkByCfi(cfi: string): BookmarkItem[] {
    if (!this.file || !this.plugin.settings.bookmarks) return [];
    const list = (this.plugin.settings.bookmarks[this.file.path] ?? []).filter(
      (b) => b.cfi !== cfi
    );
    this.plugin.settings.bookmarks[this.file.path] = list;
    this.plugin.requestSaveSettings();
    if (this.stableCfi) this.updateProgressLabels(this.stableCfi);
    return list;
  }

  async reconcilePositionWithBookNote(file: TFile, currentLoadId: number) {
    if (this.ExplicitCfiJumpPending) return;
    if (!this.linkedBookNote || !this.book || !this.rendition) return;
    if (!this.totalPagesNum || this.totalPagesNum <= 0) return;

    const fm = this.app.metadataCache.getFileCache(this.linkedBookNote.file)?.frontmatter;
    if (!fm) return;

    const rawYamlRead = fm["прочитано"];
    if (rawYamlRead === undefined || rawYamlRead === null || String(rawYamlRead).trim() === "") {
      return;
    }

    const yamlPage = Math.round(Number(rawYamlRead));
    if (!Number.isFinite(yamlPage) || yamlPage <= 0) return;

    const clampedYamlPage = Math.max(1, Math.min(this.totalPagesNum, yamlPage));
    const localPage = this.currentPageNum ?? 1;

    if (clampedYamlPage !== localPage) {
      const targetCfi = this.getCfiFromPageNumber(clampedYamlPage);
      if (targetCfi && currentLoadId === this.loadId) {
        this.stableCfi = targetCfi;
        this.plugin.settings.progress[file.path] = targetCfi;
        this.plugin.requestSaveSettings();
        try {
          await this.rendition.display(targetCfi);
        } catch {
          // Игнорируем
        }
        this.updateProgressLabels(targetCfi);
      }
    }
  }

  getCfiFromPageNumber(page: number): string | null {
    if (!this.book || !this.totalPagesNum || this.totalPagesNum <= 0) return null;
    const clampedPage = Math.max(1, Math.min(this.totalPagesNum, Math.round(page)));
    const idx = clampedPage - 1;
    const locs: any = this.book.locations;

    if (typeof locs?.cfiFromLocation === "function") {
      try {
        const cfi = locs.cfiFromLocation(idx);
        if (typeof cfi === "string" && cfi.length > 0) return cfi;
      } catch {
        // Игнорируем
      }
    }

    const list: string[] | undefined = locs?._locations;
    const fromArr = list?.[idx];
    if (typeof fromArr === "string" && fromArr.length > 0) return fromArr;

    return this.book.locations.cfiFromPercentage(
      Math.max(0, Math.min(1, idx / Math.max(1, this.totalPagesNum)))
    );
  }

  prepareMainWindowFocusBeforeModal() {
    try {
      const iframes = this.boxEl ? Array.from(this.boxEl.querySelectorAll("iframe")) : [];
      for (const f of iframes) {
        f.contentWindow?.getSelection?.()?.removeAllRanges();
        (f.contentDocument?.activeElement as HTMLElement | null)?.blur?.();
      }
      window.getSelection?.()?.removeAllRanges();
      this.contentEl?.focus?.({ preventScroll: true });
    } catch {
      // Игнорируем
    }
  }

  openJumpModal() {
    if (!this.book || !this.totalPagesNum || this.totalPagesNum <= 0) return;
    this.prepareMainWindowFocusBeforeModal();
    const curPage = this.currentPageNum ?? 1;
    new JumpToPageModal(
      this.app,
      curPage,
      this.totalPagesNum,
      this.getChapterSummaryText(),
      (targetPage) => {
        const targetCfi = this.getCfiFromPageNumber(targetPage);
        if (targetCfi) {
          this.pushNavHistory();
          void this.jumpToCfi(targetCfi, false);
        }
      }
    ).open();
  }

  async jumpToCfi(cfi: string, recordHistory = false) {
    if (!cfi) return;
    if (recordHistory) this.pushNavHistory();
    const navCfi = cfi.includes(",") ? cfi.replace(/,[^,)]+\)$/, ")") : cfi;
    this.ExplicitCfiJumpPending = true;
    this.stableCfi = navCfi;
    if (this.file) {
      this.plugin.settings.progress[this.file.path] = navCfi;
      this.plugin.requestSaveSettings();
    }
    if (this.rendition) {
      this.isResizing = false;
      try {
        await this.rendition.display(navCfi);
      } catch {
        // Игнорируем
      }
      this.updateProgressLabels(navCfi);
      if (this.isInitialLoadDone) {
        this.requestYamlProgressSync();
      }
    }
    this.ExplicitCfiJumpPending = false;
  }

  bindActionButton(btn: HTMLElement, handler: () => void) {
    let lastTrigger = 0;
    const trigger = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastTrigger < 350) return;
      lastTrigger = now;
      this.syncSelectionFromAllIframes();
      handler();
    };
    btn.addEventListener("touchstart", trigger, { passive: false });
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", trigger);
  }

  syncSelectionFromAllIframes(cfiOverride?: string) {
    try {
      const contentsList: any[] = (this.rendition as any)?.getContents?.() || [];
      for (const c of contentsList) {
        const win: Window | undefined = c?.window;
        const doc: Document | undefined = c?.document;
        const sel = win?.getSelection?.() || doc?.getSelection?.();
        const raw = sel?.toString() || "";
        if (raw.trim().length > 0) {
          this.saveCapturedText(raw, cfiOverride, c, sel);
          return;
        }
      }

      const iframes = this.boxEl ? Array.from(this.boxEl.querySelectorAll("iframe")) : [];
      for (const frame of iframes) {
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        const sel = win?.getSelection?.() || doc?.getSelection?.();
        const raw = sel?.toString() || "";
        if (raw.trim().length > 0) {
          this.saveCapturedText(raw, cfiOverride, null, sel);
          return;
        }
      }
    } catch {
      // Игнорируем
    }
  }

  saveCapturedText(raw: string, cfiOverride?: string, contentsObj?: any, selObj?: Selection | null) {
    const cleanedWord = cleanSelectedWord(raw);
    const cleanedQuote = cleanSelectedQuote(raw);
    if (!cleanedWord && !cleanedQuote) return;

    this.capturedWord = cleanedWord;
    this.capturedQuote = cleanedQuote;
    this.lastSelectionAt = Date.now();

    const sentence = extractSentenceFromSelection(selObj, cleanedWord);
    if (sentence) {
      this.extractedSentence = sentence;
    }

    if (cfiOverride) {
      this.capturedCfi = cfiOverride;
    } else if (
      contentsObj &&
      selObj &&
      selObj.rangeCount > 0 &&
      typeof contentsObj.cfiFromRange === "function"
    ) {
      try {
        const range = selObj.getRangeAt(0);
        const computedCfi = contentsObj.cfiFromRange(range);
        if (computedCfi) this.capturedCfi = computedCfi;
      } catch {
        this.capturedCfi = this.stableCfi;
      }
    } else if (!this.capturedCfi) {
      this.capturedCfi = this.stableCfi;
    }

    this.updateSelectionButtonsState();
  }

  clearCapturedSelection() {
    this.capturedWord = "";
    this.capturedQuote = "";
    this.capturedCfi = null;
    this.extractedSentence = "";
    this.updateSelectionButtonsState();
    this.prepareMainWindowFocusBeforeModal();
  }

  trySilentResolveLinkedBookNote(epubFile: TFile) {
    const folder = this.plugin.settings.booksFolder || "Знания/Книги";
    const { exactByProp } = findMatchingBookNotes(this.app, epubFile, folder);
    if (exactByProp.length === 1 && exactByProp[0]) {
      this.linkedBookNote = exactByProp[0];
    }
  }

  openBookLinkModal(onAfterLinked?: (book: BookNoteInfo) => void) {
    if (!this.file) return;
    this.prepareMainWindowFocusBeforeModal();
    const folder = this.plugin.settings.booksFolder || "Знания/Книги";
    const { exactByProp, byTitle, all } = findMatchingBookNotes(this.app, this.file, folder);
    const candidates = exactByProp.length > 0 ? exactByProp : byTitle;

    new BookLinkModal(
      this.app,
      this.file,
      folder,
      candidates,
      all,
      this.bookTitleMeta || this.file.basename,
      this.bookAuthorMeta || "",
      this.currentPageNum,
      this.totalPagesNum,
      this.currentProgressPct,
      (resolvedBook) => {
        this.linkedBookNote = resolvedBook;
        this.requestYamlProgressSync();
        void this.refreshBookHighlights();
        if (onAfterLinked) onAfterLinked(resolvedBook);
      }
    ).open();
  }

  requestYamlProgressSync() {
    if (!this.isInitialLoadDone) return;
    // Если пользователь перешёл по сноске в конец книги и плашка «↩ Назад» активна —
    // не перезаписываем прогресс в YAML заметки книги, пока он не вернётся или не закроет плашку
    if (this.navHistory.length > 0) return;
    if (!this.linkedBookNote || !this.file) return;
    if (this.linkedBookNote.linkedEpubPath !== this.file.path) return;
    if (this.totalPagesNum === null || this.totalPagesNum <= 0 || this.currentPageNum === null) return;

    this.pendingYamlSync = true;
    if (this.yamlSyncTimer) window.clearTimeout(this.yamlSyncTimer);
    this.yamlSyncTimer = window.setTimeout(() => {
      this.yamlSyncTimer = null;
      void this.flushYamlProgress();
    }, YAML_SYNC_DEBOUNCE_MS);
  }

  async flushYamlProgress() {
    if (this.yamlSyncTimer) {
      window.clearTimeout(this.yamlSyncTimer);
      this.yamlSyncTimer = null;
    }
    if (this.navHistory.length > 0) return;
    if (!this.pendingYamlSync || !this.linkedBookNote || !this.file) return;
    if (this.linkedBookNote.linkedEpubPath !== this.file.path) return;

    const noteFile = this.linkedBookNote.file;
    const pageNum = this.currentPageNum;
    const totalNum = this.totalPagesNum;
    const pctNum = this.currentProgressPct;

    if (totalNum === null || totalNum <= 0 || pageNum === null || pctNum === null) return;
    this.pendingYamlSync = false;

    const todayISO = getTodayISO();
    const fmCache = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
    if (
      fmCache &&
      fmCache["страниц"] === totalNum &&
      fmCache["прочитано"] === pageNum &&
      fmCache["прогресс"] === pctNum &&
      fmCache["последнее_чтение"] === todayISO
    ) {
      return;
    }

    try {
      await this.app.fileManager.processFrontMatter(noteFile, (fm) => {
        fm["страниц"] = totalNum;
        fm["прочитано"] = pageNum;
        fm["прогресс"] = pctNum;
        fm["последнее_чтение"] = todayISO;
        if (!fm["статус"] || fm["статус"] === "В планах") {
          fm["статус"] = "Читаю";
        }
      });
    } catch (e) {
      console.error("MyEpubPlugin error syncing YAML frontmatter:", e);
    }
  }

  updateSelectionButtonsState() {
    const hasWord = this.capturedWord.length > 0;
    const hasQuote = this.capturedQuote.length > 0;
    const shortMain =
      this.capturedWord.length > 10 ? this.capturedWord.slice(0, 9) + "…" : this.capturedWord;
    const shortFs =
      this.capturedWord.length > 7 ? this.capturedWord.slice(0, 6) + "…" : this.capturedWord;

    if (this.quickTrBtn) this.quickTrBtn.toggleClass("is-ready", hasWord);
    if (this.fsQuickTrBtn) this.fsQuickTrBtn.toggleClass("is-ready", hasWord);

    if (this.addWordBtn) {
      this.addWordBtn.toggleClass("is-ready", hasWord);
      this.addWordBtn.setText(hasWord ? `+ «${shortMain}»` : "+ Слово");
    }
    if (this.fsAddWordBtn) {
      this.fsAddWordBtn.toggleClass("is-ready", hasWord);
      this.fsAddWordBtn.setText(hasWord ? `+ «${shortFs}»` : "+ Слово");
    }
    if (this.addQuoteBtn) this.addQuoteBtn.toggleClass("is-ready", hasQuote);
    if (this.fsAddQuoteBtn) this.fsAddQuoteBtn.toggleClass("is-ready", hasQuote);
  }

  openAddWordModalWithRefresh(
    word: string,
    cfi: string | null,
    contextEx: string,
    book: BookNoteInfo,
    all: BookNoteInfo[]
  ) {
    const modal = new AddWordModal(this.app, this.plugin, word, cfi, contextEx, book, all);
    const origClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      origClose();
      window.setTimeout(() => void this.refreshBookHighlights(), 150);
    };
    modal.open();
  }

  openAddQuoteModalWithRefresh(
    quote: string,
    cfi: string | null,
    book: BookNoteInfo,
    all: BookNoteInfo[]
  ) {
    const modal = new AddQuoteModal(this.app, this.plugin, quote, cfi, book, all);
    const origClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      origClose();
      window.setTimeout(() => void this.refreshBookHighlights(), 150);
    };
    modal.open();
  }

  handleQuickTranslateClick() {
    if (!this.file) return;
    this.syncSelectionFromAllIframes();

    const textToLookup = this.capturedWord || this.capturedQuote;
    const cfiToSave = this.capturedCfi || this.stableCfi;
    const sentenceEx = this.extractedSentence;
    this.clearCapturedSelection();

    new QuickTranslateModal(this.app, textToLookup, (chosenWord) => {
      this.capturedWord = chosenWord;
      this.capturedCfi = cfiToSave;
      this.extractedSentence = sentenceEx;
      this.openWordFlowWithExplicitWord(chosenWord, cfiToSave, sentenceEx);
    }).open();
  }

  openWordFlowWithExplicitWord(wordToSave: string, cfiToSave: string | null, sentenceEx: string) {
    if (!this.file) return;
    const folder = this.plugin.settings.booksFolder || "Знания/Книги";
    const { exactByProp, all } = findMatchingBookNotes(this.app, this.file, folder);

    if (exactByProp.length === 1 && exactByProp[0]) {
      this.linkedBookNote = exactByProp[0];
      this.openAddWordModalWithRefresh(wordToSave, cfiToSave, sentenceEx, this.linkedBookNote, all);
      return;
    }

    this.openBookLinkModal((resolvedBook) => {
      const updatedAll = loadBookNotesFromVault(this.app, folder);
      this.openAddWordModalWithRefresh(wordToSave, cfiToSave, sentenceEx, resolvedBook, updatedAll);
    });
  }

  handleAddWordClick() {
    if (!this.file) return;
    this.syncSelectionFromAllIframes();

    if (!this.capturedWord) {
      new Notice("Сначала выдели незнакомое слово в тексте книги пальцем или мышью.");
      return;
    }

    const wordToSave = this.capturedWord;
    const cfiToSave = this.capturedCfi || this.stableCfi;
    const sentenceEx = this.extractedSentence;
    this.clearCapturedSelection();
    this.openWordFlowWithExplicitWord(wordToSave, cfiToSave, sentenceEx);
  }

  handleAddQuoteClick() {
    if (!this.file) return;
    this.syncSelectionFromAllIframes();

    if (!this.capturedQuote) {
      new Notice("Сначала выдели фрагмент текста в книге для сохранения цитаты.");
      return;
    }

    const quoteToSave = this.capturedQuote;
    const cfiToSave = this.capturedCfi || this.stableCfi;
    this.clearCapturedSelection();

    const folder = this.plugin.settings.booksFolder || "Знания/Книги";
    const { exactByProp, all } = findMatchingBookNotes(this.app, this.file, folder);

    if (exactByProp.length === 1 && exactByProp[0]) {
      this.linkedBookNote = exactByProp[0];
      this.openAddQuoteModalWithRefresh(quoteToSave, cfiToSave, this.linkedBookNote, all);
      return;
    }

    this.openBookLinkModal((resolvedBook) => {
      const updatedAll = loadBookNotesFromVault(this.app, folder);
      this.openAddQuoteModalWithRefresh(quoteToSave, cfiToSave, resolvedBook, updatedAll);
    });
  }

  async loadOrGenerateLocations(file: TFile, currentLoadId: number) {
    if (!this.book) return;
    const sig = `${file.stat.mtime}:${file.stat.size}`;
    const cache = this.plugin.settings.locationsCache ?? {};
    const entry = cache[file.path];

    if (entry && entry.sig === sig && entry.locations) {
      try {
        this.book.locations.load(entry.locations);
        entry.updatedAt = Date.now();
        return;
      } catch {
        // Пересчитаем заново
      }
    }

    this.info?.setText("…");
    await this.book.locations.generate(1024);
    if (currentLoadId !== this.loadId || !this.book) return;

    try {
      const serialized = this.book.locations.save();
      if (typeof serialized === "string" && serialized.length > 2) {
        if (!this.plugin.settings.locationsCache) {
          this.plugin.settings.locationsCache = {};
        }
        this.plugin.settings.locationsCache[file.path] = {
          sig,
          locations: serialized,
          updatedAt: Date.now(),
        };
        this.pruneLocationsCache();
        this.plugin.requestSaveSettings();
      }
    } catch {
      // Игнорируем
    }
  }

  pruneLocationsCache() {
    const cache = this.plugin.settings.locationsCache;
    if (!cache) return;
    const keys = Object.keys(cache);
    if (keys.length <= MAX_CACHED_BOOKS) return;

    keys.sort((a, b) => (cache[a]?.updatedAt ?? 0) - (cache[b]?.updatedAt ?? 0));
    const toRemove = keys.slice(0, keys.length - MAX_CACHED_BOOKS);
    for (const k of toRemove) {
      delete cache[k];
    }
  }

  showError(fileName: string, details: string) {
    if (!this.boxEl) return;
    this.boxEl.empty();
    const errBox = this.boxEl.createDiv("my-epub-error");
    errBox.createEl("h3", { text: "⚠️ Не удалось открыть книгу" });
    errBox.createEl("p", { text: `Файл: ${fileName}` });
    errBox.createEl("p", { cls: "my-epub-error-details", text: details });
    this.info?.setText("ошибка файла");
  }

  applyDesktopWidth(withResize = true) {
    if (!this.boxEl) return;
    if (Platform.isDesktop) {
      const pct = Math.max(50, Math.min(100, this.plugin.settings.desktopWidthPct ?? 85));
      this.boxEl.style.setProperty("--my-epub-desktop-max-width", `${pct}%`);
    } else {
      this.boxEl.style.removeProperty("--my-epub-desktop-max-width");
    }
    if (withResize) {
      this.isResizing = true;
      this.triggerResize(true);
    }
  }

  applyBarPosition() {
    const isTop = (this.plugin.settings.barPosition ?? "bottom") === "top";
    this.contentEl.toggleClass("my-epub-bar-is-top", isTop);
  }

  turnPage(dir: "next" | "prev") {
    if (!this.rendition) return;
    this.isResizing = false;
    if (this.resizeTimer) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }

    this.clearCapturedSelection();

    const anim = this.plugin.settings.pageAnimation ?? "slide";

    if (anim !== "none" && this.boxEl) {
      if (this.animTimer) window.clearTimeout(this.animTimer);
      this.boxEl.removeClass("my-epub-anim-next", "my-epub-anim-prev", "my-epub-anim-fade");
      void this.boxEl.offsetWidth;

      if (anim === "fade") {
        this.boxEl.addClass("my-epub-anim-fade");
      } else {
        this.boxEl.addClass(dir === "next" ? "my-epub-anim-next" : "my-epub-anim-prev");
      }

      this.animTimer = window.setTimeout(() => {
        this.boxEl?.removeClass("my-epub-anim-next", "my-epub-anim-prev", "my-epub-anim-fade");
      }, 240);
    }

    if (dir === "next") {
      this.rendition.next();
    } else {
      this.rendition.prev();
    }
  }

  setupGesturesAndSelection() {
    if (!this.rendition) return;

    this.rendition.on("selected", (cfiRange: string, contents: any) => {
      try {
        const sel = contents?.window?.getSelection?.() || contents?.document?.getSelection?.();
        const raw = sel?.toString() || "";
        if (raw.trim()) {
          this.saveCapturedText(raw, cfiRange, contents, sel);
        }
      } catch {
        // Игнорируем
      }
    });

    this.rendition.hooks.content.register((contents: any) => {
      const doc: Document | undefined = contents?.document;
      const win: Window | undefined = contents?.window;
      if (!doc) return;

      // Применяем тему сразу при загрузке новой главы без белой вспышки
      this.applyStyles();
      this.attachTouchHandlers(doc, true, contents);
      this.attachInternalLinkInterceptor(doc);

      const checkIframeSelection = () => {
        try {
          const sel = win?.getSelection?.() || doc.getSelection?.();
          const raw = sel?.toString() || "";
          if (raw.trim().length > 0) {
            this.saveCapturedText(raw, undefined, contents, sel);
          }
        } catch {
          // Игнорируем
        }
      };

      doc.addEventListener("selectionchange", checkIframeSelection);
      win?.addEventListener?.("selectionchange", checkIframeSelection);
      doc.addEventListener(
        "touchend",
        () => {
          window.setTimeout(checkIframeSelection, 30);
          window.setTimeout(checkIframeSelection, 180);
        },
        { passive: true }
      );
      doc.addEventListener("mouseup", () => {
        window.setTimeout(checkIframeSelection, 20);
      });
    });

    if (this.wrapEl) {
      this.attachTouchHandlers(this.wrapEl, false);
    }

    this.rendition.on("keyup", (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") this.turnPage("next");
      else if (e.key === "ArrowLeft") this.turnPage("prev");
      else if (e.key === "Escape" && this.isFullscreen) this.toggleFullscreen(false);
    });
  }

  // Перехватывает клики по сноскам [1] и внешним ссылкам внутри iframe книги
  attachInternalLinkInterceptor(doc: Document) {
    doc.addEventListener(
      "click",
      (ev: MouseEvent) => {
        const target = ev.target as HTMLElement | null;
        const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!anchor) return;

        const rawHref = anchor.getAttribute("href")?.trim() || "";
        if (!rawHref) return;

        // 1. Внешние веб-ссылки открываем в системном браузере, чтобы не ломать iframe читалки
        if (/^(https?:|mailto:|tel:)/i.test(rawHref)) {
          ev.preventDefault();
          ev.stopPropagation();
          window.open(rawHref, "_blank", "noopener,noreferrer");
          return;
        }

        // 2. Внутренние ссылки книги (сноски, примечания, ссылки на главы) —
        // запоминаем текущую страницу в стек возврата `↩ Назад к стр. N`
        this.pushNavHistory();
      },
      { capture: true }
    );
  }

  attachTouchHandlers(target: Document | HTMLElement, isInsideIframe: boolean, contentsObj?: any) {
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let startClientX = 0;
    let startTime = 0;
    let isSwiping = false;
    let active = false;
    let hadSelectionOnStart = false;

    const getDocSelectionString = (): string => {
      if (!isInsideIframe) return "";
      const doc = target as Document;
      const win = doc.defaultView;
      return (win?.getSelection?.()?.toString() || doc.getSelection?.()?.toString() || "").trim();
    };

    const onTouchStart = (ev: Event) => {
      const e = ev as TouchEvent;
      const touch = e.changedTouches?.[0] ?? e.touches?.[0];
      if (!touch) return;
      startX = touch.screenX;
      startY = touch.screenY;
      lastX = touch.screenX;
      lastY = touch.screenY;
      startClientX = touch.clientX;
      startTime = Date.now();
      isSwiping = false;
      active = true;
      hadSelectionOnStart = getDocSelectionString().length > 0;
    };

    const onTouchMove = (ev: Event) => {
      if (!active) return;

      const currentSel = getDocSelectionString();
      if (hadSelectionOnStart || currentSel.length > 0) {
        if (currentSel.length > 0) {
          const doc = target as Document;
          const sel = doc.defaultView?.getSelection?.() || doc.getSelection?.();
          this.saveCapturedText(currentSel, undefined, contentsObj, sel);
        }
        return;
      }

      const e = ev as TouchEvent;
      const touch = e.touches?.[0] ?? e.changedTouches?.[0];
      if (!touch) return;
      lastX = touch.screenX;
      lastY = touch.screenY;
      const dx = lastX - startX;
      const dy = lastY - startY;

      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        isSwiping = true;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      }
    };

    const finishTouch = (ev: Event) => {
      if (!active) return;
      active = false;

      const selAfter = getDocSelectionString();
      if (selAfter.length > 0) {
        const doc = target as Document;
        const sel = doc.defaultView?.getSelection?.() || doc.getSelection?.();
        this.saveCapturedText(selAfter, undefined, contentsObj, sel);
        return;
      }

      if (hadSelectionOnStart || Date.now() - this.lastSelectionAt < 450) {
        return;
      }

      const e = ev as TouchEvent;
      const touch = e.changedTouches?.[0];
      const endX = touch ? touch.screenX : lastX;
      const endY = touch ? touch.screenY : lastY;
      const endClientX = touch ? touch.clientX : startClientX;
      const dx = endX - startX;
      const dy = endY - startY;
      const dt = Date.now() - startTime;

      const now = Date.now();
      if (now - this.lastGestureTime < 80) return;

      if (dt < 800 && Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        this.lastGestureTime = now;
        if (dx < 0) this.turnPage("next");
        else this.turnPage("prev");
        return;
      }

      if (e.type === "touchend" && !isSwiping && dt < 350 && Math.abs(dx) < 15 && Math.abs(dy) < 15) {
        const el = e.target as HTMLElement | null;
        if (el?.closest && el.closest("a, button, .my-epub-fs-bar, .my-epub-back-pill")) return;

        this.lastGestureTime = now;
        const ratio = this.getRelativeTapRatio(target, endClientX);
        if (ratio < 0.26) {
          this.turnPage("prev");
        } else if (ratio > 0.74) {
          this.turnPage("next");
        } else {
          this.toggleFullscreen();
        }
      }
    };

    target.addEventListener("touchstart", onTouchStart, { passive: true });
    target.addEventListener("touchmove", onTouchMove, { passive: false });
    target.addEventListener("touchend", finishTouch, { passive: true });
    target.addEventListener("touchcancel", finishTouch, { passive: true });

    if (!isInsideIframe) {
      this.cleanupListeners.push(() => {
        target.removeEventListener("touchstart", onTouchStart);
        target.removeEventListener("touchmove", onTouchMove);
        target.removeEventListener("touchend", finishTouch);
        target.removeEventListener("touchcancel", finishTouch);
      });
    }
  }

  getRelativeTapRatio(target: Document | HTMLElement, clientX: number): number {
    const wrapRect = this.wrapEl?.getBoundingClientRect();
    const wrapWidth = wrapRect?.width || window.innerWidth || 1;
    const wrapLeft = wrapRect?.left || 0;

    if (target instanceof Document) {
      const frameEl = target.defaultView?.frameElement as HTMLElement | null;
      if (frameEl) {
        const frameRect = frameEl.getBoundingClientRect();
        const screenClientX = frameRect.left + clientX;
        return (screenClientX - wrapLeft) / wrapWidth;
      }
    }

    return (clientX - wrapLeft) / wrapWidth;
  }

  toggleFullscreen(force?: boolean) {
    this.isResizing = true;
    this.isFullscreen = force !== undefined ? force : !this.isFullscreen;
    this.contentEl.toggleClass("my-epub-in-fullscreen", this.isFullscreen);
    this.barEl.toggleClass("my-epub-bar-hidden", this.isFullscreen);
    this.plugin.syncGlobalBodyClasses();
    this.triggerResize(true);
  }

  async openToc() {
    this.prepareMainWindowFocusBeforeModal();
    await this.refreshBookHighlights();
    const toc = this.book?.navigation?.toc ?? [];
    const bmList = this.file ? this.plugin.settings.bookmarks?.[this.file.path] ?? [] : [];

    new BookNavModal(this.app, {
      toc,
      bookmarks: bmList,
      words: this.bookWords,
      quotes: this.bookQuotes,
      currentChapterLabel: this.currentChapterTitle || this.bookTitleMeta,
      currentPage: this.currentPageNum,
      currentPct: this.currentProgressPct,
      onSelectToc: (href) => {
        this.pushNavHistory();
        this.isResizing = false;
        this.rendition?.display(href);
      },
      onJumpCfi: (cfi) => {
        void this.jumpToCfi(cfi, true);
      },
      onToggleBookmark: () => this.toggleBookmarkOnCurrentPage(),
      onDeleteBookmark: (cfi) => this.deleteBookmarkByCfi(cfi),
    }).open();
  }

  openTypographyMenu(e: MouseEvent) {
    const menu = new Menu();
    const s = this.plugin.settings;
    const curFont = s.fontFamily ?? "serif";
    const curLh = s.lineHeight ?? 1.6;
    const curAnim = s.pageAnimation ?? "slide";
    const curPos = s.barPosition ?? "bottom";
    const curSpread = s.spreadMode ?? "none";
    const curWidth = s.desktopWidthPct ?? 85;

    const linkedLabel = this.linkedBookNote
      ? `📖 Книга: ${this.linkedBookNote.title} (сменить…)`
      : "📖 Привязать заметку книги…";

    menu.addItem((item) =>
      item.setTitle(linkedLabel).onClick(() => {
        this.openBookLinkModal();
      })
    );

    menu.addItem((item) =>
      item
        .setTitle(
          this.isCurrentPageBookmarked()
            ? "🔖 Удалить закладку с текущей страницы"
            : "🔖 Добавить закладку на этой странице"
        )
        .onClick(() => {
          this.toggleBookmarkOnCurrentPage();
        })
    );

    if (this.totalPagesNum && this.totalPagesNum > 0) {
      menu.addItem((item) =>
        item.setTitle(`🧭 Перейти к странице (1–${this.totalPagesNum})…`).onClick(() => {
          this.openJumpModal();
        })
      );
    }

    menu.addSeparator();

    const spreads: { id: SpreadMode; label: string }[] = [
      { id: "none", label: "Разворот: 1 страница" },
      { id: "auto", label: "Разворот: 2 страницы (на широком экране)" },
    ];

    for (const sp of spreads) {
      menu.addItem((item) =>
        item
          .setTitle(sp.label)
          .setChecked(curSpread === sp.id)
          .onClick(() => {
            this.applySpreadMode(sp.id);
            this.plugin.requestSaveSettings();
          })
      );
    }

    menu.addSeparator();

    const fonts: { id: FontFamily; label: string }[] = [
      { id: "serif", label: "Шрифт: С засечками (Georgia)" },
      { id: "sans", label: "Шрифт: Без засечек (Системный)" },
      { id: "default", label: "Шрифт: Из файла книги" },
      { id: "mono", label: "Шрифт: Моноширинный" },
    ];

    for (const f of fonts) {
      menu.addItem((item) =>
        item
          .setTitle(f.label)
          .setChecked(curFont === f.id)
          .onClick(() => {
            s.fontFamily = f.id;
            this.applyStylesAndRestore();
            this.plugin.requestSaveSettings();
          })
      );
    }

    menu.addSeparator();

    const lineHeights = [
      { val: 1.35, label: "Интервал: Плотный (1.35)" },
      { val: 1.6, label: "Интервал: Комфортный (1.6)" },
      { val: 1.85, label: "Интервал: Свободный (1.85)" },
    ];

    for (const lh of lineHeights) {
      menu.addItem((item) =>
        item
          .setTitle(lh.label)
          .setChecked(Math.abs(curLh - lh.val) < 0.05)
          .onClick(() => {
            s.lineHeight = lh.val;
            this.applyStylesAndRestore();
            this.plugin.requestSaveSettings();
          })
      );
    }

    if (Platform.isDesktop) {
      menu.addSeparator();
      const widths = [
        { val: 65, label: "Ширина (ПК): Узкая (65%)" },
        { val: 75, label: "Ширина (ПК): Средняя (75%)" },
        { val: 85, label: "Ширина (ПК): Широкая (85%)" },
        { val: 100, label: "Ширина (ПК): На всю ширину (100%)" },
      ];
      for (const w of widths) {
        menu.addItem((item) =>
          item
            .setTitle(w.label)
            .setChecked(Math.abs(curWidth - w.val) < 3)
            .onClick(() => {
              s.desktopWidthPct = w.val;
              this.applyDesktopWidth(true);
              this.plugin.requestSaveSettings();
            })
        );
      }
    }

    menu.addSeparator();

    const anims: { id: PageAnimation; label: string }[] = [
      { id: "slide", label: "Анимация: Слайд" },
      { id: "fade", label: "Анимация: Мягкое затухание" },
      { id: "none", label: "Анимация: Выключена" },
    ];

    for (const a of anims) {
      menu.addItem((item) =>
        item
          .setTitle(a.label)
          .setChecked(curAnim === a.id)
          .onClick(() => {
            s.pageAnimation = a.id;
            this.plugin.requestSaveSettings();
          })
      );
    }

    menu.addSeparator();

    const positions: { id: BarPosition; label: string }[] = [
      { id: "bottom", label: "Панель: Снизу" },
      { id: "top", label: "Панель: Сверху" },
    ];

    for (const p of positions) {
      menu.addItem((item) =>
        item
          .setTitle(p.label)
          .setChecked(curPos === p.id)
          .onClick(() => {
            s.barPosition = p.id;
            this.isResizing = true;
            this.applyBarPosition();
            this.plugin.requestSaveSettings();
            this.triggerResize(true);
          })
      );
    }

    menu.showAtMouseEvent(e);
  }

  isCurrentPageBookmarked(): boolean {
    if (!this.file || !this.currentPageNum) return false;
    const list = this.plugin.settings.bookmarks?.[this.file.path] ?? [];
    return list.some((b) => b.page === this.currentPageNum);
  }

  triggerResize(force = false) {
    if (!this.boxEl) return;

    if (!force) {
      if (document.querySelector(".modal-container")) return;
      const activeTag = document.activeElement?.tagName;
      if (activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT") return;
    }

    const { clientWidth, clientHeight } = this.boxEl;
    if (clientWidth <= 0 || clientHeight <= 0) return;

    if (
      !force &&
      Math.abs(clientWidth - this.lastBoxWidth) < 3 &&
      Math.abs(clientHeight - this.lastBoxHeight) < 3
    ) {
      return;
    }

    const savedAnchor = this.stableCfi;
    this.isResizing = true;
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);

    this.resizeTimer = window.setTimeout(() => {
      if (!this.rendition || !this.boxEl) {
        this.isResizing = false;
        return;
      }
      const w = this.boxEl.clientWidth;
      const h = this.boxEl.clientHeight;
      if (w <= 0 || h <= 0) {
        this.isResizing = false;
        return;
      }

      this.lastBoxWidth = w;
      this.lastBoxHeight = h;

      this.rendition.resize(w, h);

      this.resizeTimer = window.setTimeout(async () => {
        if (!this.rendition) {
          this.isResizing = false;
          return;
        }
        if (savedAnchor) {
          this.stableCfi = savedAnchor;
          try {
            await this.rendition.display(savedAnchor);
          } catch {
            // Игнорируем
          }
        }
        window.setTimeout(() => {
          this.isResizing = false;
          if (this.file && this.stableCfi) {
            const cur: any = this.rendition?.currentLocation();
            if (cur?.start) this.captureChapterMetricsFromLoc(cur);
            this.plugin.settings.progress[this.file.path] = this.stableCfi;
            this.plugin.requestSaveSettings();
            this.updateProgressLabels(this.stableCfi);
          }
        }, 60);
      }, 120);
    }, 160);
  }

  setupResizeObserver() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.triggerResize(false));
    this.resizeObserver.observe(this.boxEl);
  }

  updateThemeBtnText() {
    if (!this.themeBtn) return;
    const isSepia = this.plugin.settings.themeMode === "sepia";
    this.themeBtn.setText(isSepia ? "📜" : "🌗");
    this.themeBtn.setAttr("aria-label", isSepia ? "Режим: Сепия" : "Режим: Авто (тема Obsidian)");
  }

  toggleThemeMode() {
    const s = this.plugin.settings;
    s.themeMode = s.themeMode === "sepia" ? "auto" : "sepia";
    this.updateThemeBtnText();
    this.applyStyles();
    this.plugin.requestSaveSettings();
  }

  applyStylesAndRestore() {
    const targetCfi = this.stableCfi;
    this.isResizing = true;
    this.applyStyles();
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(async () => {
      if (this.rendition && targetCfi) {
        this.stableCfi = targetCfi;
        try {
          await this.rendition.display(targetCfi);
        } catch {
          // Игнорируем
        }
      }
      window.setTimeout(() => {
        this.isResizing = false;
        const cur: any = this.rendition?.currentLocation();
        if (cur?.start) this.captureChapterMetricsFromLoc(cur);
        if (targetCfi) this.updateProgressLabels(targetCfi);
      }, 60);
    }, 140);
  }

  applyStyles() {
    if (!this.rendition) return;
    const s = this.plugin.settings;
    const isSepia = s.themeMode === "sepia";

    this.contentEl.toggleClass("my-epub-is-sepia", isSepia);
    this.plugin.syncGlobalBodyClasses();

    const computed = getComputedStyle(document.body);
    const bg = isSepia
      ? "#f4ecd8"
      : computed.getPropertyValue("--background-primary").trim() || "#1e1e1e";
    const fg = isSepia
      ? "#3b2f2f"
      : computed.getPropertyValue("--text-normal").trim() || "#dcddde";
    const link = isSepia
      ? "#8b4513"
      : computed.getPropertyValue("--text-accent").trim() || "#7f6df2";

    const fontCss = FONT_MAP[s.fontFamily ?? "serif"];
    const lh = String(s.lineHeight ?? 1.6);

    this.rendition.themes.fontSize(s.fontSize + "%");
    this.rendition.themes.default({
      "html, body": {
        "background-color": `${bg} !important`,
        "color": `${fg} !important`,
        "font-family": `${fontCss} !important`,
        "line-height": `${lh} !important`,
        "padding": "0 12px !important",
        "max-width": "none !important",
        "touch-action": "pan-y !important",
        "-webkit-user-select": "text !important",
        "user-select": "text !important",
      },
      "p, div, span, li, blockquote": {
        "color": "inherit !important",
        "background-color": "transparent !important",
        "font-family": "inherit !important",
        "line-height": "inherit !important",
        "max-width": "none !important",
        "-webkit-user-select": "text !important",
        "user-select": "text !important",
      },
      "h1, h2, h3, h4, h5, h6": {
        "color": "inherit !important",
        "background-color": "transparent !important",
        "font-family": "inherit !important",
        "-webkit-user-select": "text !important",
        "user-select": "text !important",
      },
      "img, svg, video, canvas": {
        "max-width": "100% !important",
        "max-height": "78vh !important",
        "width": "auto !important",
        "height": "auto !important",
        "object-fit": "contain !important",
        "display": "block !important",
        "margin": "0.5em auto !important",
        "break-inside": "avoid !important",
      },
      "table": {
        "max-width": "100% !important",
        "width": "auto !important",
        "border-collapse": "collapse !important",
        "overflow-wrap": "break-word !important",
        "break-inside": "avoid !important",
      },
      "th, td": {
        "padding": "4px 6px !important",
        "border": `1px solid ${fg}44 !important`,
        "overflow-wrap": "break-word !important",
      },
      "a, a:link, a:visited": {
        "color": `${link} !important`,
      },
    });
  }

  setFont(delta: number) {
    const s = this.plugin.settings;
    s.fontSize = Math.max(60, Math.min(250, s.fontSize + delta));
    this.applyStylesAndRestore();
    this.plugin.requestSaveSettings();
  }

  updateProgressLabels(cfi: string) {
    if (!this.book) return;
    const total = this.book.locations.length();
    if (total > 0) {
      const idx = Number(this.book.locations.locationFromCfi(cfi));
      const page = Math.max(1, Math.min(total, idx + 1));
      const pct = Math.max(0, Math.min(100, Math.round(this.book.locations.percentageFromCfi(cfi) * 100)));

      this.currentPageNum = page;
      this.totalPagesNum = total;
      this.currentProgressPct = pct;

      const bmMark = this.isCurrentPageBookmarked() ? "🔖 " : "";
      let chapterLeftSuffix = "";
      if (this.chapterPageCurrent !== null && this.chapterPageTotal !== null) {
        const left = Math.max(0, this.chapterPageTotal - this.chapterPageCurrent);
        chapterLeftSuffix = left === 0 ? " · конец гл." : ` · гл.: ост. ${left} стр.`;
      }

      const summary = this.getChapterSummaryText();
      if (summary) {
        this.info.setAttr("title", `${summary}. Нажми для быстрого перехода.`);
      }

      this.info.setText(`${bmMark}стр. ${page} / ${total} · ${pct}%${chapterLeftSuffix}`);
      this.fsInfoEl?.setText(`${bmMark}${page}/${total} · ${pct}% ⛶`);
    } else {
      this.info.setText("…");
      this.fsInfoEl?.setText("… ⛶");
    }
  }

  onRelocated(file: TFile, loc: any) {
    const cfi: string = loc?.start?.cfi;
    if (!cfi || !this.book) return;

    if (
      (this.isResizing || document.querySelector(".modal-container")) &&
      this.stableCfi
    ) {
      return;
    }

    this.captureChapterMetricsFromLoc(loc);
    this.stableCfi = cfi;
    this.plugin.settings.progress[file.path] = cfi;
    this.plugin.requestSaveSettings();
    this.updateProgressLabels(cfi);
    this.requestYamlProgressSync();
  }

  cleanupView() {
    this.loadId++;
    this.isFullscreen = false;
    this.isInitialLoadDone = false;
    this.navHistory = [];
    this.plugin.syncGlobalBodyClasses();
    if (this.resizeTimer) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.animTimer) {
      window.clearTimeout(this.animTimer);
      this.animTimer = null;
    }
    for (const fn of this.cleanupListeners) {
      try { fn(); } catch { /* ignore */ }
    }
    this.cleanupListeners = [];
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    try { this.rendition?.destroy(); } catch { /* ignore */ }
    try { this.book?.destroy(); } catch { /* ignore */ }
    this.rendition = null;
    this.book = null;
  }

  async onUnloadFile() {
    await this.flushYamlProgress();
    this.cleanupView();
    await this.plugin.flushSaveSettings();
  }

  async onClose() {
    await this.flushYamlProgress();
    this.cleanupView();
    await this.plugin.flushSaveSettings();
  }
}

class EpubSettingTab extends PluginSettingTab {
  plugin: MyEpubPlugin;

  constructor(app: App, plugin: MyEpubPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Папка заметок книг")
      .setDesc("Папка с заметками книг для дашборда (по умолчанию: Знания/Книги)")
      .addText((text) =>
        text
          .setPlaceholder("Знания/Книги")
          .setValue(this.plugin.settings.booksFolder ?? "Знания/Книги")
          .onChange((val) => {
            this.plugin.settings.booksFolder = val.trim() || "Знания/Книги";
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Заметка словаря (Spaced Repetition)")
      .setDesc("Имя или путь к файлу со словами (по умолчанию: Words Cards)")
      .addText((text) =>
        text
          .setPlaceholder("Words Cards")
          .setValue(this.plugin.settings.wordsFilePath ?? "Words Cards")
          .onChange((val) => {
            this.plugin.settings.wordsFilePath = val.trim() || "Words Cards";
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Заметка цитат")
      .setDesc("Путь к файлу цитат (по умолчанию: Знания/Цитаты из книг.md)")
      .addText((text) =>
        text
          .setPlaceholder("Знания/Цитаты из книг.md")
          .setValue(this.plugin.settings.quotesFilePath ?? "Знания/Цитаты из книг.md")
          .onChange((val) => {
            this.plugin.settings.quotesFilePath = val.trim() || "Знания/Цитаты из книг.md";
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Книжный разворот")
      .setDesc("Показывать 1 страницу или 2 страницы рядом на широком экране (ПК / горизонтальный iPad)")
      .addDropdown((drop) =>
        drop
          .addOption("none", "1 страница")
          .addOption("auto", "2 страницы (Авто)")
          .setValue(this.plugin.settings.spreadMode ?? "none")
          .onChange((val) => {
            this.plugin.settings.spreadMode = val as SpreadMode;
            this.plugin.requestSaveSettings();
            this.plugin.refreshAllViews();
          })
      );

    const pct = this.plugin.settings.desktopWidthPct ?? 85;
    let widthSetting: Setting;

    widthSetting = new Setting(containerEl)
      .setName("Ширина текста на ПК")
      .setDesc(`Доля от ширины вкладки (сейчас: ${pct}%). На iPad и телефоне остаётся стандартная колонка.`)
      .addSlider((slider) =>
        slider
          .setLimits(50, 100, 5)
          .setValue(pct)
          .setDynamicTooltip()
          .onChange((val) => {
            this.plugin.settings.desktopWidthPct = val;
            widthSetting.setDesc(
              `Доля от ширины вкладки (сейчас: ${val}%). На iPad и телефоне остаётся стандартная колонка.`
            );
            this.plugin.requestSaveSettings();
            this.plugin.refreshAllViews();
          })
      )
      .addExtraButton((btn) =>
        btn
          .setIcon("maximize")
          .setTooltip("На всю ширину (100%)")
          .onClick(async () => {
            this.plugin.settings.desktopWidthPct = 100;
            await this.plugin.flushSaveSettings();
            this.plugin.refreshAllViews();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Положение панели управления")
      .setDesc("Где показывать панель кнопок читалки")
      .addDropdown((drop) =>
        drop
          .addOption("bottom", "Снизу")
          .addOption("top", "Сверху")
          .setValue(this.plugin.settings.barPosition ?? "bottom")
          .onChange((val) => {
            this.plugin.settings.barPosition = val as BarPosition;
            this.plugin.requestSaveSettings();
            this.plugin.refreshAllViews();
          })
      );

    const cacheCount = Object.keys(this.plugin.settings.locationsCache ?? {}).length;
    new Setting(containerEl)
      .setName("Кэш номеров страниц")
      .setDesc(`Сохранено книг в кэше: ${cacheCount} (макс. ${MAX_CACHED_BOOKS}). Ускоряет повторное открытие книг.`)
      .addButton((btn) =>
        btn
          .setButtonText("Очистить кэш")
          .onClick(async () => {
            this.plugin.settings.locationsCache = {};
            await this.plugin.flushSaveSettings();
            new Notice("Кэш страниц очищен");
            this.display();
          })
      );
  }
}

export default class MyEpubPlugin extends Plugin {
  settings!: Settings;
  private saveTimer: number | null = null;
  private dirty = false;

  async onload() {
    this.settings = migrateSettings(await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new EpubView(leaf, this));
    this.registerExtensions(["epub"], VIEW_TYPE);
    this.addSettingTab(new EpubSettingTab(this.app, this));

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        void this.flushAllViewsAndSettings();
      }
    });

    this.registerObsidianProtocolHandler("my-epub", async (params) => {
      const fileParam = params.file;
      const cfiParam = params.cfi;
      if (fileParam) {
        await this.openEpubAt(fileParam, cfiParam || undefined);
      }
    });

    this.addCommand({
      id: "quick-translate-selected-word",
      name: "Быстрый перевод и озвучка без сохранения в словарь",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(EpubView);
        if (!view) return false;
        if (!checking) view.handleQuickTranslateClick();
        return true;
      },
    });

    this.addCommand({
      id: "add-selected-word-to-vocabulary",
      name: "Добавить выделенное слово в словарь",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(EpubView);
        if (!view) return false;
        if (!checking) view.handleAddWordClick();
        return true;
      },
    });

    this.addCommand({
      id: "add-selected-quote-to-notes",
      name: "Добавить выделенную цитату из книги",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(EpubView);
        if (!view) return false;
        if (!checking) view.handleAddQuoteClick();
        return true;
      },
    });

    this.addCommand({
      id: "toggle-book-page-bookmark",
      name: "Добавить или удалить закладку на текущей странице",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(EpubView);
        if (!view) return false;
        if (!checking) view.toggleBookmarkOnCurrentPage();
        return true;
      },
    });

    this.addCommand({
      id: "jump-to-book-page",
      name: "Перейти к странице или проценту книги",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(EpubView);
        if (!view) return false;
        if (!checking) view.openJumpModal();
        return true;
      },
    });

    this.addCommand({
      id: "link-or-create-book-note",
      name: "Привязать или создать заметку книги",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(EpubView);
        if (!view) return false;
        if (!checking) view.openBookLinkModal();
        return true;
      },
    });
  }

  async onExternalSettingsChange() {
    await this.reloadSettingsFromDisk();
  }

  async reloadSettingsFromDisk() {
    if (this.dirty) return;
    try {
      const diskData = await this.loadData();
      if (diskData) {
        this.settings = migrateSettings(diskData);
      }
    } catch {
      // Игнорируем
    }
  }

  async flushAllViewsAndSettings() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof EpubView) {
        await view.flushYamlProgress();
      }
    }
    await this.flushSaveSettings();
  }

  syncGlobalBodyClasses() {
    const activeView = this.app.workspace.getActiveViewOfType(EpubView);
    const isFs = Boolean(activeView && activeView.isFullscreen);
    const isSepia = Boolean(activeView && this.settings.themeMode === "sepia");
    document.body.classList.toggle("my-epub-fullscreen", isFs);
    document.body.classList.toggle("my-epub-sepia-bg", isFs && isSepia);
  }

  async openEpubAt(epubLinkOrPath: string, cfi?: string) {
    const clean = epubLinkOrPath.replace(/^\[\[|\]\]$/g, "").split("|")[0]?.split("#")[0]?.trim() || "";
    if (!clean) return;

    let targetFile: TFile | null = null;
    const direct = this.app.vault.getAbstractFileByPath(clean);
    if (direct instanceof TFile) {
      targetFile = direct;
    } else {
      const dest = this.app.metadataCache.getFirstLinkpathDest(clean, "");
      if (dest instanceof TFile) targetFile = dest;
    }

    if (!targetFile) {
      new Notice(`Файл книги «${clean}» не найден в хранилище.`);
      return;
    }

    await this.reloadSettingsFromDisk();

    const navCfi = cfi && cfi.includes(",") ? cfi.replace(/,[^,)]+\)$/, ")") : cfi;
    if (navCfi) {
      this.settings.progress[targetFile.path] = navCfi;
      this.requestSaveSettings();
    }

    const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of existingLeaves) {
      const view = leaf.view;
      if (view instanceof EpubView && view.file?.path === targetFile.path) {
        if (navCfi) view.ExplicitCfiJumpPending = true;
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        if (navCfi) await view.jumpToCfi(navCfi, true);
        return;
      }
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(targetFile);
    if (navCfi && leaf.view instanceof EpubView) {
      await leaf.view.jumpToCfi(navCfi, false);
    }
  }

  refreshAllViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof EpubView) {
        view.applyBarPosition();
        view.applySpreadMode(this.settings.spreadMode ?? "none");
        view.applyDesktopWidth(true);
        view.applyStylesAndRestore();
      }
    }
  }

  requestSaveSettings() {
    this.dirty = true;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.dirty = false;
      void this.saveData(this.settings);
    }, 400);
  }

  async flushSaveSettings() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.dirty = false;
      await this.saveData(this.settings);
    }
  }

  saveSettings() {
    this.requestSaveSettings();
  }

  onunload() {
    document.body.classList.remove("my-epub-fullscreen", "my-epub-sepia-bg");
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.dirty = false;
      void this.saveData(this.settings);
    }
  }
}