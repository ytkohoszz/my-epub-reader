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
const SELECTION_THROTTLE_MS = 120;

type ThemeMode = "auto" | "sepia";
type FontFamily = "default" | "serif" | "sans" | "mono";
type PageAnimation = "slide" | "fade" | "none";
type BarPosition = "bottom" | "top";
type SpreadMode = "none" | "auto";

interface LegacyLocationCacheEntry {
  sig: string;
  locations: string;
  updatedAt: number;
}

export interface LocationIndexMeta {
  fileName: string;
  sig: string;
  updatedAt: number;
}

interface NavHistoryItem {
  cfi: string;
  page: number;
}

export interface Settings {
  progress: Record<string, string>;
  progressUpdatedAt?: Record<string, string>;
  fontSize: number;
  themeMode?: ThemeMode;
  fontFamily?: FontFamily;
  lineHeight?: number;
  pageAnimation?: PageAnimation;
  barPosition?: BarPosition;
  spreadMode?: SpreadMode;
  desktopWidthPct?: number;
  locationsCache?: Record<string, LegacyLocationCacheEntry>;
  bookmarks?: Record<string, BookmarkItem[]>;
  booksFolder?: string;
  wordsFilePath?: string;
  quotesFilePath?: string;
}

const DEFAULTS: Settings = {
  progress: {},
  progressUpdatedAt: {},
  fontSize: 120,
  themeMode: "auto",
  fontFamily: "serif",
  lineHeight: 1.6,
  pageAnimation: "slide",
  barPosition: "bottom",
  spreadMode: "none",
  desktopWidthPct: 85,
  bookmarks: {},
  booksFolder: "Знания/Книги",
  wordsFilePath: "Words Cards",
  quotesFilePath: "Знания/Цитаты из книг.md",
};

function migrateSettings(raw: any): Settings {
  const s: Settings = Object.assign({}, DEFAULTS, raw || {});
  if (!s.progress || typeof s.progress !== "object") s.progress = {};
  if (!s.progressUpdatedAt || typeof s.progressUpdatedAt !== "object") s.progressUpdatedAt = {};
  if (typeof s.fontSize !== "number" || isNaN(s.fontSize)) s.fontSize = DEFAULTS.fontSize;
  if (!s.bookmarks || typeof s.bookmarks !== "object") s.bookmarks = {};
  if (!s.booksFolder || typeof s.booksFolder !== "string") s.booksFolder = DEFAULTS.booksFolder;
  if (!s.wordsFilePath || typeof s.wordsFilePath !== "string") s.wordsFilePath = DEFAULTS.wordsFilePath;
  if (!s.quotesFilePath || typeof s.quotesFilePath !== "string") s.quotesFilePath = DEFAULTS.quotesFilePath;
  if (s.spreadMode !== "auto" && s.spreadMode !== "none") s.spreadMode = "none";
  return s;
}

function hashBookPathToFileName(bookPath: string): string {
  let h = 2166136261;
  for (let i = 0; i < bookPath.length; i++) {
    h ^= bookPath.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `loc-${hex}.json`;
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

  // A1: флаг однократной подписки на события workspace за жизнь view
  private workspaceEventsRegistered = false;

  // A2: реестр всех таймеров выделения в iframe для гарантированной очистки
  private selectionTimers = new Set<number>();

  stableCfi: string | null = null;
  lastLocalPositionSavedAt: string | null = null;
  isResizing = false;
  isInitialLoadDone = false;
  isGeneratingLocations = false;
  ExplicitCfiJumpPending = false;
  lastBoxWidth = 0;
  lastBoxHeight = 0;
  loadId = 0;
  cleanupListeners: Array<() => void> = [];

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
  approxProgressPct: number | null = null;
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

  async onOpen() {
    await super.onOpen();
    this.ensureWorkspaceEventsRegistered();
  }

  private ensureWorkspaceEventsRegistered() {
    if (this.workspaceEventsRegistered) return;
    this.workspaceEventsRegistered = true;
    this.registerEvent(
      this.app.workspace.on("css-change", () => this.applyStyles())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.plugin.syncGlobalBodyClasses())
    );
  }

  async onLoadFile(file: TFile) {
    this.ensureWorkspaceEventsRegistered();
    await this.flushYamlProgress();
    this.cleanupView();
    const currentLoadId = ++this.loadId;

    await this.plugin.reloadSettingsFromDisk();
    if (currentLoadId !== this.loadId) return;

    const root = this.contentEl;
    root.empty();
    root.addClass("my-epub");
    root.setAttr("tabindex", "-1");

    this.isResizing = false;
    this.isInitialLoadDone = false;
    this.isGeneratingLocations = false;
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
    this.approxProgressPct = null;
    this.chapterPageCurrent = null;
    this.chapterPageTotal = null;
    this.currentChapterTitle = "";
    this.pendingYamlSync = false;

    // A3: сразу ищем привязанную заметку книги и выбираем более свежую стартовую позицию
    this.trySilentResolveLinkedBookNote(file);
    const initialPos = this.resolveInitialCfiBeforeRender(file);
    this.stableCfi = initialPos.cfi;
    this.lastLocalPositionSavedAt = initialPos.savedAt;

    this.wrapEl = root.createDiv("my-epub-wrap");
    this.boxEl = this.wrapEl.createDiv("my-epub-box");
    this.applyDesktopWidth(false);
    this.applySpreadClass();

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
      if (currentLoadId !== this.loadId || !this.book || !this.rendition) return;

      // A4 + A5: пробуем мгновенно загрузить locations из файлового кэша плагина
      const loadedFromCache = await this.tryLoadCachedLocations(file, currentLoadId);
      if (currentLoadId !== this.loadId || !this.book || !this.rendition) return;

      const cur: any = this.rendition.currentLocation();
      if (cur?.start?.cfi) {
        this.captureChapterMetricsFromLoc(cur);
        this.stableCfi = cur.start.cfi;
        this.updateProgressLabels(cur.start.cfi);
      }

      if (loadedFromCache) {
        await this.reconcilePositionWithBookNote(file, currentLoadId);
        if (currentLoadId !== this.loadId) return;
        this.isInitialLoadDone = true;
        this.ExplicitCfiJumpPending = false;
        this.requestYamlProgressSync();
      } else {
        // A5: не блокируем UI — книга уже открыта и показывает примерный % через cfiFromPercentage / spine,
        // а генерацию страниц запускаем в фоне с проверкой loadId
        this.isGeneratingLocations = true;
        if (this.stableCfi) this.updateProgressLabels(this.stableCfi);
        void this.generateLocationsInBackground(file, currentLoadId);
      }
    } catch (err: any) {
      if (currentLoadId !== this.loadId) return;
      console.error("MyEpubPlugin error loading file:", err);
      this.showError(file.name, err?.message || "Не удалось прочитать файл EPUB.");
    }
  }

  // A3: предвыбор стартового CFI до рендера книги (сравнение времени YAML и data.json)
  private resolveInitialCfiBeforeRender(file: TFile): { cfi: string | null; savedAt: string | null } {
    const localCfi = this.plugin.settings.progress[file.path] || null;
    const localTimeStr = this.plugin.settings.progressUpdatedAt?.[file.path] || null;

    if (this.ExplicitCfiJumpPending || !this.linkedBookNote) {
      return { cfi: localCfi, savedAt: localTimeStr };
    }

    const fm = this.app.metadataCache.getFileCache(this.linkedBookNote.file)?.frontmatter;
    if (!fm) return { cfi: localCfi, savedAt: localTimeStr };

    const rawYamlCfi = typeof fm["позиция"] === "string" ? fm["позиция"].trim() : "";
    const yamlCfi = rawYamlCfi.startsWith("epubcfi(") ? rawYamlCfi : null;
    const yamlTimeStr =
      typeof fm["позиция_время"] === "string" && fm["позиция_время"].trim()
        ? fm["позиция_время"].trim()
        : null;

    const rawPct = fm["прогресс"];
    if (rawPct !== undefined && rawPct !== null && String(rawPct).trim() !== "") {
      const n = Number(rawPct);
      if (Number.isFinite(n) && n >= 0 && n <= 100) {
        this.approxProgressPct = Math.round(n);
      }
    }

    if (!yamlCfi) {
      return { cfi: localCfi, savedAt: localTimeStr };
    }

    const yamlMs = yamlTimeStr ? Date.parse(yamlTimeStr) : NaN;
    const localMs = localTimeStr ? Date.parse(localTimeStr) : NaN;

    if (Number.isFinite(yamlMs) && Number.isFinite(localMs)) {
      if (yamlMs > localMs) {
        this.plugin.setLocalBookProgress(file.path, yamlCfi, yamlTimeStr!);
        return { cfi: yamlCfi, savedAt: yamlTimeStr };
      }
      return { cfi: localCfi, savedAt: localTimeStr };
    }

    // Если времени нет хотя бы с одной стороны — приоритет у YAML
    return { cfi: yamlCfi, savedAt: yamlTimeStr || localTimeStr };
  }

  // A4: чтение кэша страниц из отдельного файла в папке плагина
  private async tryLoadCachedLocations(file: TFile, currentLoadId: number): Promise<boolean> {
    if (!this.book) return false;
    const sig = `${file.stat.mtime}:${file.stat.size}`;
    const cachedJson = await this.plugin.loadLocationsCacheFile(file.path, sig);
    if (currentLoadId !== this.loadId || !this.book || !cachedJson) return false;

    try {
      this.book.locations.load(cachedJson);
      return this.book.locations.length() > 0;
    } catch {
      return false;
    }
  }

  // A5: неблокирующая фоновая генерация страниц с учётом loadId
  private async generateLocationsInBackground(file: TFile, currentLoadId: number) {
    if (!this.book) return;
    const sig = `${file.stat.mtime}:${file.stat.size}`;
    try {
      await this.book.locations.generate(1024);
      if (currentLoadId !== this.loadId || !this.book || !this.rendition) return;

      this.isGeneratingLocations = false;
      try {
        const serialized = this.book.locations.save();
        if (typeof serialized === "string" && serialized.length > 2) {
          await this.plugin.saveLocationsCacheFile(file.path, sig, serialized);
        }
      } catch {
        // Игнорируем ошибку записи кэша
      }

      if (currentLoadId !== this.loadId || !this.book || !this.rendition) return;

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
    } catch {
      if (currentLoadId === this.loadId) {
        this.isGeneratingLocations = false;
      }
    }
  }

  // A5: оценка процента через cfiFromPercentage / spine, пока locations.generate ещё идёт
  private computeFastPercentage(cfi: string, loc?: any): number {
    if (!this.book) return this.approxProgressPct ?? 0;

    if (this.book.locations && this.book.locations.length() > 0) {
      const p = this.book.locations.percentageFromCfi(cfi);
      if (typeof p === "number" && Number.isFinite(p)) {
        return Math.max(0, Math.min(100, Math.round(p * 100)));
      }
    }

    const start = loc?.start ?? (this.rendition?.currentLocation() as any)?.start;
    const spineItems: any[] | undefined = (this.book.spine as any)?.spineItems;
    const spineLen = spineItems?.length || 0;

    if (start && typeof start.index === "number" && spineLen > 0) {
      const dispPage = start.displayed?.page ?? 1;
      const dispTotal = Math.max(1, start.displayed?.total ?? 1);
      const frac = (start.index + (dispPage - 1) / dispTotal) / spineLen;
      const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
      // Проверяем cfiFromPercentage, если epubjs поддерживает его для текущего состояния
      try {
        if (typeof this.book.locations?.cfiFromPercentage === "function" && this.book.locations.length() > 0) {
          void this.book.locations.cfiFromPercentage(pct / 100);
        }
      } catch {
        // Игнорируем
      }
      this.approxProgressPct = pct;
      return pct;
    }

    return this.approxProgressPct ?? 0;
  }

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

    this.computeFastPercentage(loc?.start?.cfi || "", loc);

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
    const pct = this.currentProgressPct ?? this.approxProgressPct ?? 0;

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

  // A3: сверка локальной позиции и YAML заметки книги по метке времени (позиция_время vs progressUpdatedAt)
  async reconcilePositionWithBookNote(file: TFile, currentLoadId: number) {
    if (this.ExplicitCfiJumpPending) return;
    if (!this.linkedBookNote || !this.book || !this.rendition) return;
    if (!this.totalPagesNum || this.totalPagesNum <= 0) return;

    const fm = this.app.metadataCache.getFileCache(this.linkedBookNote.file)?.frontmatter;
    if (!fm) return;

    const rawYamlCfi = typeof fm["позиция"] === "string" ? fm["позиция"].trim() : "";
    const yamlCfi = rawYamlCfi.startsWith("epubcfi(") ? rawYamlCfi : null;
    const yamlTimeStr =
      typeof fm["позиция_время"] === "string" && fm["позиция_время"].trim()
        ? fm["позиция_время"].trim()
        : null;

    const rawYamlRead = fm["прочитано"];
    const hasYamlRead =
      rawYamlRead !== undefined && rawYamlRead !== null && String(rawYamlRead).trim() !== "";
    const parsedYamlPage = hasYamlRead ? Math.round(Number(rawYamlRead)) : NaN;
    const yamlPage =
      Number.isFinite(parsedYamlPage) && parsedYamlPage > 0
        ? Math.max(1, Math.min(this.totalPagesNum, parsedYamlPage))
        : null;

    const localTimeStr =
      this.lastLocalPositionSavedAt || this.plugin.settings.progressUpdatedAt?.[file.path] || null;
    const yamlMs = yamlTimeStr ? Date.parse(yamlTimeStr) : NaN;
    const localMs = localTimeStr ? Date.parse(localTimeStr) : NaN;
    const hasBothTimes = Number.isFinite(yamlMs) && Number.isFinite(localMs);

    const localPage = this.currentPageNum ?? 1;

    const pickTargetCfiFromYaml = (): string | null => {
      if (yamlCfi) {
        if (yamlPage !== null) {
          const cfiIdx = Number(this.book!.locations.locationFromCfi(yamlCfi));
          const cfiPage = Math.max(1, Math.min(this.totalPagesNum!, cfiIdx + 1));
          // Если в дашборде вручную изменили `прочитано`, переходим к указанной странице
          if (Math.abs(cfiPage - yamlPage) >= 1) {
            return this.getCfiFromPageNumber(yamlPage);
          }
        }
        return yamlCfi;
      }
      if (yamlPage !== null) {
        return this.getCfiFromPageNumber(yamlPage);
      }
      return null;
    };

    if (hasBothTimes) {
      // Оба времени известны — побеждает более свежая запись
      if (localMs > yamlMs) {
        return;
      }
      if (yamlMs > localMs) {
        const targetCfi = pickTargetCfiFromYaml();
        if (targetCfi && targetCfi !== this.stableCfi && currentLoadId === this.loadId) {
          this.stableCfi = targetCfi;
          this.lastLocalPositionSavedAt = yamlTimeStr;
          this.plugin.setLocalBookProgress(file.path, targetCfi, yamlTimeStr!);
          try {
            await this.rendition.display(targetCfi);
          } catch {
            // Игнорируем
          }
          this.updateProgressLabels(targetCfi);
        }
        return;
      }
      // Если времена равны, но `прочитано` в YAML было изменено вручную в дашборде
      if (yamlPage !== null && yamlPage !== localPage) {
        const targetCfi = this.getCfiFromPageNumber(yamlPage);
        if (targetCfi && currentLoadId === this.loadId) {
          const nowIso = new Date().toISOString();
          this.stableCfi = targetCfi;
          this.lastLocalPositionSavedAt = nowIso;
          this.plugin.setLocalBookProgress(file.path, targetCfi, nowIso);
          try {
            await this.rendition.display(targetCfi);
          } catch {
            // Игнорируем
          }
          this.updateProgressLabels(targetCfi);
        }
      }
      return;
    }

    // Если времени нет хотя бы с одной стороны — поведение прежнее (YAML приоритетнее)
    if (yamlPage !== null && yamlPage !== localPage) {
      const targetCfi = pickTargetCfiFromYaml();
      if (targetCfi && currentLoadId === this.loadId) {
        const syncedTime = yamlTimeStr || new Date().toISOString();
        this.stableCfi = targetCfi;
        this.lastLocalPositionSavedAt = syncedTime;
        this.plugin.setLocalBookProgress(file.path, targetCfi, syncedTime);
        try {
          await this.rendition.display(targetCfi);
        } catch {
          // Игнорируем
        }
        this.updateProgressLabels(targetCfi);
      }
    } else if (yamlCfi && yamlCfi !== this.stableCfi && !this.stableCfi) {
      const syncedTime = yamlTimeStr || new Date().toISOString();
      this.stableCfi = yamlCfi;
      this.lastLocalPositionSavedAt = syncedTime;
      this.plugin.setLocalBookProgress(file.path, yamlCfi, syncedTime);
      try {
        await this.rendition.display(yamlCfi);
      } catch {
        // Игнорируем
      }
      this.updateProgressLabels(yamlCfi);
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
    if (!this.book) return;
    if (!this.totalPagesNum || this.totalPagesNum <= 0) {
      new Notice("Страницы ещё считаются — подожди пару секунд.");
      return;
    }
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
    const nowIso = new Date().toISOString();
    this.ExplicitCfiJumpPending = true;
    this.stableCfi = navCfi;
    this.lastLocalPositionSavedAt = nowIso;
    if (this.file) {
      this.plugin.setLocalBookProgress(this.file.path, navCfi, nowIso);
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
    if (this.navHistory.length > 0) return;
    if (!this.linkedBookNote || !this.file) return;
    if (this.linkedBookNote.linkedEpubPath !== this.file.path) return;
    if (!this.stableCfi) return;

    this.pendingYamlSync = true;
    if (this.yamlSyncTimer) window.clearTimeout(this.yamlSyncTimer);
    this.yamlSyncTimer = window.setTimeout(() => {
      this.yamlSyncTimer = null;
      void this.flushYamlProgress();
    }, YAML_SYNC_DEBOUNCE_MS);
  }

  // A3: запись прогресса, `позиция` (epubcfi) и `позиция_время` (ISO-строка) в YAML заметки книги
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
    const pctNum = this.currentProgressPct ?? this.approxProgressPct;
    const cfiToSync = this.stableCfi;
    const posTimeIso =
      this.lastLocalPositionSavedAt ||
      this.plugin.settings.progressUpdatedAt?.[this.file.path] ||
      new Date().toISOString();

    if (!cfiToSync) return;
    this.pendingYamlSync = false;

    const todayISO = getTodayISO();
    const fmCache = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
    if (
      fmCache &&
      (totalNum === null || fmCache["страниц"] === totalNum) &&
      (pageNum === null || fmCache["прочитано"] === pageNum) &&
      (pctNum === null || fmCache["прогресс"] === pctNum) &&
      fmCache["последнее_чтение"] === todayISO &&
      fmCache["позиция"] === cfiToSync &&
      fmCache["позиция_время"] === posTimeIso
    ) {
      return;
    }

    try {
      await this.app.fileManager.processFrontMatter(noteFile, (fm) => {
        if (totalNum !== null && totalNum > 0) fm["страниц"] = totalNum;
        if (pageNum !== null && pageNum > 0) fm["прочитано"] = pageNum;
        if (pctNum !== null && pctNum >= 0) fm["прогресс"] = pctNum;
        fm["последнее_чтение"] = todayISO;
        fm["позиция"] = cfiToSync;
        fm["позиция_время"] = posTimeIso;
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

  private scheduleSelectionTimer(fn: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.selectionTimers.delete(id);
      fn();
    }, ms);
    this.selectionTimers.add(id);
    return id;
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

      // A2: throttle ~120 мс для selectionchange без дублирующего слушателя на window
      let lastSelCheckTime = 0;
      let selThrottleTimer: number | null = null;

      const onThrottledSelectionChange = () => {
        const now = Date.now();
        const elapsed = now - lastSelCheckTime;
        if (elapsed >= SELECTION_THROTTLE_MS) {
          if (selThrottleTimer !== null) {
            window.clearTimeout(selThrottleTimer);
            this.selectionTimers.delete(selThrottleTimer);
            selThrottleTimer = null;
          }
          lastSelCheckTime = now;
          checkIframeSelection();
        } else if (selThrottleTimer === null) {
          selThrottleTimer = this.scheduleSelectionTimer(() => {
            selThrottleTimer = null;
            lastSelCheckTime = Date.now();
            checkIframeSelection();
          }, SELECTION_THROTTLE_MS - elapsed);
        }
      };

      const onDocTouchEnd = () => {
        this.scheduleSelectionTimer(checkIframeSelection, 30);
        this.scheduleSelectionTimer(checkIframeSelection, 180);
      };

      const onDocMouseUp = () => {
        this.scheduleSelectionTimer(checkIframeSelection, 20);
      };

      doc.addEventListener("selectionchange", onThrottledSelectionChange);
      doc.addEventListener("touchend", onDocTouchEnd, { passive: true });
      doc.addEventListener("mouseup", onDocMouseUp);

      this.cleanupListeners.push(() => {
        if (selThrottleTimer !== null) {
          window.clearTimeout(selThrottleTimer);
          this.selectionTimers.delete(selThrottleTimer);
          selThrottleTimer = null;
        }
        doc.removeEventListener("selectionchange", onThrottledSelectionChange);
        doc.removeEventListener("touchend", onDocTouchEnd);
        doc.removeEventListener("mouseup", onDocMouseUp);
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

  attachInternalLinkInterceptor(doc: Document) {
    doc.addEventListener(
      "click",
      (ev: MouseEvent) => {
        const target = ev.target as HTMLElement | null;
        const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!anchor) return;

        const rawHref = anchor.getAttribute("href")?.trim() || "";
        if (!rawHref) return;

        if (/^(https?:|mailto:|tel:)/i.test(rawHref)) {
          ev.preventDefault();
          ev.stopPropagation();
          window.open(rawHref, "_blank", "noopener,noreferrer");
          return;
        }

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
      currentPct: this.currentProgressPct ?? this.approxProgressPct,
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
    if (!this.file) return false;
    const list = this.plugin.settings.bookmarks?.[this.file.path] ?? [];
    if (this.currentPageNum) {
      return list.some((b) => b.page === this.currentPageNum);
    }
    return Boolean(this.stableCfi && list.some((b) => b.cfi === this.stableCfi));
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

    if (total > 0) {
      const idx = Number(this.book.locations.locationFromCfi(cfi));
      const page = Math.max(1, Math.min(total, idx + 1));
      const pct = Math.max(
        0,
        Math.min(100, Math.round(this.book.locations.percentageFromCfi(cfi) * 100))
      );

      this.currentPageNum = page;
      this.totalPagesNum = total;
      this.currentProgressPct = pct;
      this.approxProgressPct = pct;

      this.info.setText(`${bmMark}стр. ${page} / ${total} · ${pct}%${chapterLeftSuffix}`);
      this.fsInfoEl?.setText(`${bmMark}${page}/${total} · ${pct}% ⛶`);
    } else {
      // A5: пока locations.generate ещё считается, сразу показываем процент без блокировки UI
      const fastPct = this.computeFastPercentage(cfi);
      this.info.setText(`${bmMark}~${fastPct}%${chapterLeftSuffix} · считаю стр.…`);
      this.fsInfoEl?.setText(`${bmMark}~${fastPct}% ⛶`);
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

    if (this.isInitialLoadDone) {
      const nowIso = new Date().toISOString();
      this.lastLocalPositionSavedAt = nowIso;
      this.plugin.setLocalBookProgress(file.path, cfi, nowIso);
    } else {
      this.plugin.settings.progress[file.path] = cfi;
      this.plugin.requestSaveSettings();
    }

    this.updateProgressLabels(cfi);
    this.requestYamlProgressSync();
  }

  cleanupView() {
    this.loadId++;
    this.isFullscreen = false;
    this.isInitialLoadDone = false;
    this.isGeneratingLocations = false;
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
    for (const timerId of this.selectionTimers) {
      window.clearTimeout(timerId);
    }
    this.selectionTimers.clear();
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

    const cacheCount = this.plugin.getCachedBooksCount();
    new Setting(containerEl)
      .setName("Кэш номеров страниц")
      .setDesc(
        `Сохранено книг в отдельных файлах плагина: ${cacheCount} (макс. ${MAX_CACHED_BOOKS}). Ускоряет повторное открытие книг.`
      )
      .addButton((btn) =>
        btn
          .setButtonText("Очистить кэш")
          .onClick(async () => {
            await this.plugin.clearAllLocationsCacheFiles();
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
  private locationsIndex: Record<string, LocationIndexMeta> = {};

  async onload() {
    this.settings = migrateSettings(await this.loadData());
    await this.initAndMigrateLocationsCache();

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

    // A6: команды палитры через addCommand с checkCallback (только при активном EpubView)
    this.addCommand({
      id: "next-page",
      name: "Следующая страница",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(EpubView);
        if (!view) return false;
        if (!checking) view.turnPage("next");
        return true;
      },
    });

    this.addCommand({
      id: "prev-page",
      name: "Предыдущая страница",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(EpubView);
        if (!view) return false;
        if (!checking) view.turnPage("prev");
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
      id: "open-table-of-contents",
      name: "Открыть оглавление, закладки и выписанные слова",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(EpubView);
        if (!view) return false;
        if (!checking) void view.openToc();
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

  getPluginDir(): string {
    return this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  private getLocationsIndexPath(): string {
    return `${this.getPluginDir()}/locations-index.json`;
  }

  getCachedBooksCount(): number {
    return Object.keys(this.locationsIndex).length;
  }

  // A4: инициализация индекса и миграция старого locationsCache из data.json в отдельные файлы
  async initAndMigrateLocationsCache() {
    const adapter = this.app.vault.adapter;
    const indexPath = this.getLocationsIndexPath();

    try {
      if (await adapter.exists(indexPath)) {
        const raw = await adapter.read(indexPath);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          this.locationsIndex = parsed;
        }
      }
    } catch {
      this.locationsIndex = {};
    }

    const legacy = this.settings.locationsCache;
    if (legacy && typeof legacy === "object" && Object.keys(legacy).length > 0) {
      const pluginDir = this.getPluginDir();
      for (const [bookPath, entry] of Object.entries(legacy)) {
        if (
          entry &&
          typeof entry.sig === "string" &&
          typeof entry.locations === "string" &&
          entry.locations.length > 2
        ) {
          const fileName = hashBookPathToFileName(bookPath);
          const filePath = `${pluginDir}/${fileName}`;
          try {
            await adapter.write(filePath, entry.locations);
            this.locationsIndex[bookPath] = {
              fileName,
              sig: entry.sig,
              updatedAt: entry.updatedAt || Date.now(),
            };
          } catch {
            // Игнорируем ошибку переноса отдельного файла
          }
        }
      }
      delete this.settings.locationsCache;
      await this.pruneLocationsCacheFiles();
      await this.saveLocationsIndexToDisk();
      await this.saveData(this.settings);
    } else if ("locationsCache" in this.settings) {
      delete this.settings.locationsCache;
      await this.saveData(this.settings);
    }
  }

  private async saveLocationsIndexToDisk() {
    try {
      await this.app.vault.adapter.write(
        this.getLocationsIndexPath(),
        JSON.stringify(this.locationsIndex)
      );
    } catch {
      // Игнорируем
    }
  }

  async loadLocationsCacheFile(bookPath: string, expectedSig: string): Promise<string | null> {
    const meta = this.locationsIndex[bookPath];
    if (!meta || meta.sig !== expectedSig || !meta.fileName) return null;

    const fullPath = `${this.getPluginDir()}/${meta.fileName}`;
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(fullPath))) return null;
      const content = await adapter.read(fullPath);
      if (!content || content.length <= 2) return null;
      meta.updatedAt = Date.now();
      void this.saveLocationsIndexToDisk();
      return content;
    } catch {
      return null;
    }
  }

  async saveLocationsCacheFile(bookPath: string, sig: string, serializedLocations: string) {
    const fileName = hashBookPathToFileName(bookPath);
    const fullPath = `${this.getPluginDir()}/${fileName}`;
    try {
      await this.app.vault.adapter.write(fullPath, serializedLocations);
      this.locationsIndex[bookPath] = {
        fileName,
        sig,
        updatedAt: Date.now(),
      };
      await this.pruneLocationsCacheFiles();
      await this.saveLocationsIndexToDisk();
    } catch {
      // Игнорируем
    }
  }

  private async pruneLocationsCacheFiles() {
    const keys = Object.keys(this.locationsIndex);
    if (keys.length <= MAX_CACHED_BOOKS) return;

    keys.sort(
      (a, b) =>
        (this.locationsIndex[a]?.updatedAt ?? 0) - (this.locationsIndex[b]?.updatedAt ?? 0)
    );
    const toRemove = keys.slice(0, keys.length - MAX_CACHED_BOOKS);
    const adapter = this.app.vault.adapter;
    const pluginDir = this.getPluginDir();

    for (const k of toRemove) {
      const meta = this.locationsIndex[k];
      delete this.locationsIndex[k];
      if (meta?.fileName) {
        const fullPath = `${pluginDir}/${meta.fileName}`;
        try {
          if (await adapter.exists(fullPath)) {
            await adapter.remove(fullPath);
          }
        } catch {
          // Игнорируем
        }
      }
    }
  }

  async clearAllLocationsCacheFiles() {
    const adapter = this.app.vault.adapter;
    const pluginDir = this.getPluginDir();
    for (const meta of Object.values(this.locationsIndex)) {
      if (meta?.fileName) {
        const fullPath = `${pluginDir}/${meta.fileName}`;
        try {
          if (await adapter.exists(fullPath)) {
            await adapter.remove(fullPath);
          }
        } catch {
          // Игнорируем
        }
      }
    }
    this.locationsIndex = {};
    await this.saveLocationsIndexToDisk();
    if ("locationsCache" in this.settings) {
      delete this.settings.locationsCache;
      await this.flushSaveSettings();
    }
  }

  setLocalBookProgress(filePath: string, cfi: string, isoTime = new Date().toISOString()) {
    this.settings.progress[filePath] = cfi;
    if (!this.settings.progressUpdatedAt) {
      this.settings.progressUpdatedAt = {};
    }
    this.settings.progressUpdatedAt[filePath] = isoTime;
    this.requestSaveSettings();
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
      this.setLocalBookProgress(targetFile.path, navCfi, new Date().toISOString());
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