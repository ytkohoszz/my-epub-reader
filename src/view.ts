import {
  FileView,
  Menu,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import ePub, { Book, Rendition } from "epubjs";
import {
  AddQuoteModal,
  AddWordModal,
  BookLinkModal,
  BookNoteInfo,
  JumpToPageModal,
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
import {
  BarPosition,
  EpubBookExtended,
  EpubRelocatedEvent,
  EpubRenditionExtended,
  FONT_MAP,
  FontFamily,
  NavHistoryItem,
  PageAnimation,
  READING_TICK_INTERVAL_MS,
  SpreadMode,
  TextAlignMode,
  ThemeMode,
  VIEW_TYPE,
  YAML_SYNC_DEBOUNCE_MS,
  getErrorMessage,
} from "./settings";
import {
  accrueActiveReadingTime,
  buildChapterSummaryText,
  captureChapterMetricsFromLoc,
  computeFastPercentage,
  flushBookYamlProgress,
  generateLocationsInBackground,
  getCfiFromPageNumber,
   reconcilePositionWithBookNote,
  recordPageTransitionForPace,
  resolveInitialCfiBeforeRender,
  tryLoadCachedLocations,
} from "./progress";
import {
  bindActionButton,
  setupViewGesturesAndSelection,
  syncSelectionFromAllIframes,
} from "./gestures";
import type MyEpubPlugin from "./main";

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
  readingTickTimer: number | null = null;
  isFullscreen = false;
  lastGestureTime = 0;

  private workspaceEventsRegistered = false;
  private selectionTimers = new Set<number>();

  turnDurationsMs: number[] = [];
  lastTransitionTimestamp = 0;

  lastActivityAt = 0;
  lastReadingTickAt = 0;
  unsavedReadingSeconds = 0;

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
      this.app.workspace.on("active-leaf-change", () => {
        this.plugin.syncGlobalBodyClasses();
        this.recordReadingActivity();
      })
    );
  }

  recordReadingActivity() {
    const now = Date.now();
    accrueActiveReadingTime(this, now);
    this.lastActivityAt = now;
    this.lastReadingTickAt = now;
  }

  private startReadingTimer() {
    if (this.readingTickTimer !== null) window.clearInterval(this.readingTickTimer);
    const now = Date.now();
    this.lastActivityAt = now;
    this.lastReadingTickAt = now;
    this.readingTickTimer = window.setInterval(() => {
      accrueActiveReadingTime(this, Date.now());
      if (this.unsavedReadingSeconds >= 60) {
        this.requestYamlProgressSync();
      }
    }, READING_TICK_INTERVAL_MS);
  }

  scheduleSelectionTimer(fn: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.selectionTimers.delete(id);
      fn();
    }, ms);
    this.selectionTimers.add(id);
    return id;
  }

  clearSelectionTimer(id: number) {
    window.clearTimeout(id);
    this.selectionTimers.delete(id);
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
    this.turnDurationsMs = [];
    this.lastTransitionTimestamp = Date.now();
    this.unsavedReadingSeconds = 0;
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

    this.trySilentResolveLinkedBookNote(file);
    const initialPos = resolveInitialCfiBeforeRender(this, file);
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
      attr: {
        title: "Скрыть кнопку возврата и остаться здесь",
        "aria-label": "Скрыть кнопку возврата",
      },
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
    const fsPrev = this.fsBarEl.createEl("button", {
      cls: "my-epub-fs-btn",
      text: "◀",
      attr: { "aria-label": "Предыдущая страница" },
    });
    this.fsInfoEl = this.fsBarEl.createSpan({
      cls: "my-epub-fs-info",
      text: "… · ⛶",
      attr: { "aria-label": "Выйти из полноэкранного режима" },
    });
    this.fsQuickTrBtn = this.fsBarEl.createEl("button", {
      cls: "my-epub-fs-btn my-epub-word-btn",
      text: "🌐",
      attr: { "aria-label": "Быстрый перевод" },
    });
    this.fsAddWordBtn = this.fsBarEl.createEl("button", {
      cls: "my-epub-fs-btn my-epub-word-btn",
      text: "+ Слово",
      attr: { "aria-label": "Добавить слово в словарь" },
    });
    this.fsAddQuoteBtn = this.fsBarEl.createEl("button", {
      cls: "my-epub-fs-btn my-epub-word-btn",
      text: "💬",
      attr: { "aria-label": "Добавить цитату" },
    });
    const fsNext = this.fsBarEl.createEl("button", {
      cls: "my-epub-fs-btn",
      text: "▶",
      attr: { "aria-label": "Следующая страница" },
    });

    fsPrev.onclick = (e) => { e.stopPropagation(); this.turnPage("prev"); };
    fsNext.onclick = (e) => { e.stopPropagation(); this.turnPage("next"); };
    this.fsInfoEl.onclick = (e) => { e.stopPropagation(); this.toggleFullscreen(false); };
    bindActionButton(this, this.fsQuickTrBtn, () => this.handleQuickTranslateClick());
    bindActionButton(this, this.fsAddWordBtn, () => this.handleAddWordClick());
    bindActionButton(this, this.fsAddQuoteBtn, () => this.handleAddQuoteClick());

    this.barEl = root.createDiv("my-epub-bar");
    this.applyBarPosition();

    const leftGroup = this.barEl.createDiv("my-epub-group");
    const prev = leftGroup.createEl("button", {
      cls: "my-epub-btn",
      text: "◀",
      attr: { "aria-label": "Предыдущая страница" },
    });
    const tocBtn = leftGroup.createEl("button", {
      cls: "my-epub-btn",
      text: "📑",
      attr: { "aria-label": "Оглавление, закладки, слова и поиск" },
    });
    const smaller = leftGroup.createEl("button", {
      cls: "my-epub-btn",
      text: "A−",
      attr: { "aria-label": "Уменьшить размер шрифта" },
    });

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
      attr: { "aria-label": "Добавить выделенное слово в словарь" },
    });
    this.addQuoteBtn = rightGroup.createEl("button", {
      cls: "my-epub-btn my-epub-word-btn",
      text: "💬",
      attr: { "aria-label": "Добавить выделенную цитату" },
    });
    bindActionButton(this, this.quickTrBtn, () => this.handleQuickTranslateClick());
    bindActionButton(this, this.addWordBtn, () => this.handleAddWordClick());
    bindActionButton(this, this.addQuoteBtn, () => this.handleAddQuoteClick());
    this.updateSelectionButtonsState();

    const bigger = rightGroup.createEl("button", {
      cls: "my-epub-btn",
      text: "A+",
      attr: { "aria-label": "Увеличить размер шрифта" },
    });
    const fontBtn = rightGroup.createEl("button", {
      cls: "my-epub-btn",
      text: "🔤",
      attr: { "aria-label": "Вид, шрифт, поля, выравнивание и привязка книги" },
    });
    this.themeBtn = rightGroup.createEl("button", { cls: "my-epub-btn" });
    this.updateThemeBtnText();
    this.fsBtn = rightGroup.createEl("button", {
      cls: "my-epub-btn",
      text: "⛶",
      attr: { "aria-label": "Полноэкранный режим" },
    });
    const next = rightGroup.createEl("button", {
      cls: "my-epub-btn",
      text: "▶",
      attr: { "aria-label": "Следующая страница" },
    });

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
      setupViewGesturesAndSelection(this);

      prev.onclick = () => this.turnPage("prev");
      next.onclick = () => this.turnPage("next");
      smaller.onclick = () => this.setFont(-10);
      bigger.onclick = () => this.setFont(10);
      this.themeBtn.onclick = () => this.toggleThemeMode();
      this.fsBtn.onclick = () => this.toggleFullscreen();
      tocBtn.onclick = () => this.openToc();
      fontBtn.onclick = (e) => this.openTypographyMenu(e);

      this.rendition.on("relocated", (loc: EpubRelocatedEvent) =>
        this.onRelocated(file, loc)
      );

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
      this.startReadingTimer();

      await this.book.ready;
      if (currentLoadId !== this.loadId || !this.book) return;

      try {
        const bookExt = this.book as unknown as EpubBookExtended;
        const meta = await bookExt.loaded?.metadata;
        if (meta?.title) this.bookTitleMeta = String(meta.title).trim();
        if (meta?.creator) this.bookAuthorMeta = String(meta.creator).trim();
      } catch {
        // Игнорируем
      }

      this.trySilentResolveLinkedBookNote(file);
      await this.refreshBookHighlights();
      if (currentLoadId !== this.loadId || !this.book || !this.rendition) return;

      const loadedFromCache = await tryLoadCachedLocations(this, file, currentLoadId);
      if (currentLoadId !== this.loadId || !this.book || !this.rendition) return;

      const rendExt = this.rendition as unknown as EpubRenditionExtended;
      const cur = rendExt.currentLocation?.();
      if (cur?.start?.cfi) {
        captureChapterMetricsFromLoc(this, cur);
        this.stableCfi = cur.start.cfi;
        this.updateProgressLabels(cur.start.cfi);
      }

      if (loadedFromCache) {
        await reconcilePositionWithBookNote(this, file, currentLoadId);
        if (currentLoadId !== this.loadId) return;
        this.isInitialLoadDone = true;
        this.ExplicitCfiJumpPending = false;
        this.requestYamlProgressSync();
      } else {
        this.isGeneratingLocations = true;
        if (this.stableCfi) this.updateProgressLabels(this.stableCfi);
        void generateLocationsInBackground(this, file, currentLoadId);
      }
    } catch (err: unknown) {
      if (currentLoadId !== this.loadId) return;
      console.error("MyEpubPlugin error loading file:", err);
      this.showError(file.name, getErrorMessage(err));
    }
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

  getChapterSummaryText(): string {
    return buildChapterSummaryText(this);
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
        const targetCfi = getCfiFromPageNumber(this, targetPage);
        if (targetCfi) {
          this.pushNavHistory();
          void this.jumpToCfi(targetCfi, false);
        }
      }
    ).open();
  }

  async jumpToCfi(cfi: string, recordHistory = false) {
    if (!cfi) return;
    this.recordReadingActivity();
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

  async flushYamlProgress() {
    await flushBookYamlProgress(this);
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
    syncSelectionFromAllIframes(this);

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
    syncSelectionFromAllIframes(this);

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
    syncSelectionFromAllIframes(this);

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
    this.recordReadingActivity();
    if (dir === "next") {
      recordPageTransitionForPace(this);
    } else {
      this.lastTransitionTimestamp = Date.now();
    }

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

  toggleFullscreen(force?: boolean) {
    this.recordReadingActivity();
    this.isResizing = true;
    this.isFullscreen = force !== undefined ? force : !this.isFullscreen;
    this.contentEl.toggleClass("my-epub-in-fullscreen", this.isFullscreen);
    this.barEl.toggleClass("my-epub-bar-hidden", this.isFullscreen);
    this.plugin.syncGlobalBodyClasses();
    this.triggerResize(true);
  }

  async openToc() {
    this.recordReadingActivity();
    this.prepareMainWindowFocusBeforeModal();
    await this.refreshBookHighlights();
    const toc = this.book?.navigation?.toc ?? [];
    const bmList = this.file ? this.plugin.settings.bookmarks?.[this.file.path] ?? [] : [];

    new BookNavModal(this.app, {
      book: this.book,
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
    this.recordReadingActivity();
    const menu = new Menu();
    const s = this.plugin.settings;
    const curTheme = s.themeMode ?? "auto";
    const curFont = s.fontFamily ?? "serif";
    const curLh = s.lineHeight ?? 1.6;
    const curMargin = s.pageMarginPx ?? 12;
    const curAlign = s.textAlign ?? "default";
    const curHyphens = Boolean(s.hyphens);
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

    const themes: { id: ThemeMode; label: string }[] = [
      { id: "auto", label: "Тема: Авто (как в Obsidian)" },
      { id: "sepia", label: "Тема: 📜 Сепия" },
      { id: "night", label: "Тема: 🌙 Ночь" },
    ];
    for (const tm of themes) {
      menu.addItem((item) =>
        item
          .setTitle(tm.label)
          .setChecked(curTheme === tm.id)
          .onClick(() => {
            s.themeMode = tm.id;
            this.updateThemeBtnText();
            this.applyStyles();
            this.plugin.requestSaveSettings();
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

    menu.addSeparator();

    const margins = [
      { val: 6, label: "Поля страницы: Узкие (6 px)" },
      { val: 12, label: "Поля страницы: Стандартные (12 px)" },
      { val: 28, label: "Поля страницы: Широкие (28 px)" },
    ];
    for (const mg of margins) {
      menu.addItem((item) =>
        item
          .setTitle(mg.label)
          .setChecked(Math.abs(curMargin - mg.val) <= 2)
          .onClick(() => {
            s.pageMarginPx = mg.val;
            this.applyStylesAndRestore();
            this.plugin.requestSaveSettings();
          })
      );
    }

    const aligns: { id: TextAlignMode; label: string }[] = [
      { id: "default", label: "Выравнивание: По умолчанию" },
      { id: "justify", label: "Выравнивание: По ширине" },
      { id: "left", label: "Выравнивание: По левому краю" },
    ];
    for (const al of aligns) {
      menu.addItem((item) =>
        item
          .setTitle(al.label)
          .setChecked(curAlign === al.id)
          .onClick(() => {
            s.textAlign = al.id;
            this.applyStylesAndRestore();
            this.plugin.requestSaveSettings();
          })
      );
    }

    menu.addItem((item) =>
      item
        .setTitle("Переносы слов (Hyphens)")
        .setChecked(curHyphens)
        .onClick(() => {
          s.hyphens = !curHyphens;
          this.applyStylesAndRestore();
          this.plugin.requestSaveSettings();
        })
    );

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
            const rendExt = this.rendition as unknown as EpubRenditionExtended | null;
            const cur = rendExt?.currentLocation?.();
            if (cur?.start) captureChapterMetricsFromLoc(this, cur);
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
    const mode = this.plugin.settings.themeMode ?? "auto";
    const icon = mode === "sepia" ? "📜" : mode === "night" ? "🌙" : "🌗";
    const label =
      mode === "sepia"
        ? "Режим: Сепия (нажми для режима Ночь)"
        : mode === "night"
          ? "Режим: Ночь (нажми для Авто)"
          : "Режим: Авто (нажми для Сепии)";
    this.themeBtn.setText(icon);
    this.themeBtn.setAttr("aria-label", label);
  }

  toggleThemeMode() {
    this.recordReadingActivity();
    const s = this.plugin.settings;
    const cur = s.themeMode ?? "auto";
    s.themeMode = cur === "auto" ? "sepia" : cur === "sepia" ? "night" : "auto";
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
        const rendExt = this.rendition as unknown as EpubRenditionExtended | null;
        const cur = rendExt?.currentLocation?.();
        if (cur?.start) captureChapterMetricsFromLoc(this, cur);
        if (targetCfi) this.updateProgressLabels(targetCfi);
      }, 60);
    }, 140);
  }

  applyStyles() {
    if (!this.rendition) return;
    const s = this.plugin.settings;
    const mode = s.themeMode ?? "auto";
    const isSepia = mode === "sepia";
    const isNight = mode === "night";

    this.contentEl.toggleClass("my-epub-is-sepia", isSepia);
    this.contentEl.toggleClass("my-epub-is-night", isNight);
    this.plugin.syncGlobalBodyClasses();

    const computed = getComputedStyle(document.body);
    const bg = isSepia
      ? "#f4ecd8"
      : isNight
        ? "#121316"
        : computed.getPropertyValue("--background-primary").trim() || "#1e1e1e";
    const fg = isSepia
      ? "#3b2f2f"
      : isNight
        ? "#c9ccd1"
        : computed.getPropertyValue("--text-normal").trim() || "#dcddde";
    const link = isSepia
      ? "#8b4513"
      : isNight
        ? "#8ab4f8"
        : computed.getPropertyValue("--text-accent").trim() || "#7f6df2";

    const fontCss = FONT_MAP[s.fontFamily ?? "serif"];
    const lh = String(s.lineHeight ?? 1.6);
    const marginPx = Math.max(0, Math.min(64, s.pageMarginPx ?? 12));
    const alignMode = s.textAlign ?? "default";
    const alignCss =
      alignMode === "justify"
        ? "justify !important"
        : alignMode === "left"
          ? "left !important"
          : "inherit";
    const hyphensCss = s.hyphens ? "auto !important" : "manual !important";

    this.rendition.themes.fontSize(s.fontSize + "%");
    this.rendition.themes.default({
      "html, body": {
        "background-color": `${bg} !important`,
        "color": `${fg} !important`,
        "font-family": `${fontCss} !important`,
        "line-height": `${lh} !important`,
        "padding": `0 ${marginPx}px !important`,
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
        "text-align": alignCss,
        "-webkit-hyphens": hyphensCss,
        "hyphens": hyphensCss,
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

    if (this.bookWords.length > 0 || this.bookQuotes.length > 0) {
      applyHighlightsToRendition(
        this.rendition,
        this.appliedHighlightCfis,
        this.bookWords,
        this.bookQuotes
      );
    }
  }

  setFont(delta: number) {
    this.recordReadingActivity();
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
      const fastPct = computeFastPercentage(this, cfi);
      this.info.setText(`${bmMark}~${fastPct}%${chapterLeftSuffix} · считаю стр.…`);
      this.fsInfoEl?.setText(`${bmMark}~${fastPct}% ⛶`);
    }
  }

  onRelocated(file: TFile, loc: EpubRelocatedEvent) {
    const cfi = loc?.start?.cfi;
    if (!cfi || !this.book) return;

    if (
      (this.isResizing || document.querySelector(".modal-container")) &&
      this.stableCfi
    ) {
      return;
    }

    this.recordReadingActivity();
    captureChapterMetricsFromLoc(this, loc);
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
    if (this.readingTickTimer !== null) {
      window.clearInterval(this.readingTickTimer);
      this.readingTickTimer = null;
    }
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