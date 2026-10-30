import {
  App,
  FileView,
  Modal,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import ePub, { Book, Rendition } from "epubjs";
import { toNavigationCfi, withNavigationTimeout } from "./navigation";
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
  getCfiFromPageNumberSafe,
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

// Модальное окно настроек вида и чтения вместо системного Menu
class AppearanceModal extends Modal {
  view: EpubView;

  constructor(app: App, view: EpubView) {
    super(app);
    (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection = false;
    this.view = view;
  }

  safeClose() {
    try {
      (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection = false;
      this.close();
    } catch {
      // Игнорируем
    }
  }

  onOpen() {
    (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection = false;
    this.render();
  }

  private renderChipGroup<T extends string | number>(
    parent: HTMLElement,
    label: string,
    options: Array<{ id: T; label: string }>,
    isActive: (id: T) => boolean,
    onPick: (id: T, chosenLabel: string) => void
  ) {
    const sec = parent.createDiv("my-epub-appear-section");
    sec.createDiv({ cls: "my-epub-appear-label", text: label });
    const row = sec.createDiv("my-epub-appear-chips");
    for (const opt of options) {
      const btn = row.createEl("button", {
        cls: "my-epub-appear-chip" + (isActive(opt.id) ? " is-active" : ""),
        text: opt.label,
        attr: { type: "button" },
      });
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPick(opt.id, opt.label);
        this.render();
      };
    }
  }

  render() {
    const { contentEl } = this;
    const prevScrollTop = contentEl.scrollTop;
    contentEl.empty();
    contentEl.addClass("my-epub-modal", "my-epub-appear-modal");

    const ver = this.view.plugin.manifest?.version || "0.2.8";
    const head = contentEl.createDiv("my-epub-word-head");
    head.createSpan({
      cls: "my-epub-word-title",
      text: `🔤 Вид и настройки чтения (${ver})`,
    });

    const s = this.view.plugin.settings;
    const curTheme = s.themeMode ?? "auto";
    const curSpread = s.spreadMode ?? "none";
    const curFont = s.fontFamily ?? "serif";
    const curLh = s.lineHeight ?? 1.6;
    const curMargin = s.pageMarginPx ?? 12;
    const curAlign = s.textAlign ?? "default";
    const curHyphens = Boolean(s.hyphens);
    const curAnim = s.pageAnimation ?? "slide";
    const curPos = s.barPosition ?? "bottom";
    const curWidth = s.desktopWidthPct ?? 85;

    const topActions = contentEl.createDiv("my-epub-appear-actions");

    const linkedLabel = this.view.linkedBookNote
      ? `📖 Книга: ${this.view.linkedBookNote.title} (сменить…)`
      : "📖 Привязать заметку книги…";
    const linkBookBtn = topActions.createEl("button", {
      cls: "my-epub-appear-action-btn",
      text: linkedLabel,
      attr: { type: "button" },
    });
    linkBookBtn.onclick = () => {
      this.safeClose();
      this.view.openBookLinkModal();
    };

    const isBm = this.view.isCurrentPageBookmarked();
    const bmBtn = topActions.createEl("button", {
      cls: "my-epub-appear-action-btn" + (isBm ? " is-active" : ""),
      text: isBm
        ? "🔖 Удалить закладку со страницы"
        : "🔖 Добавить закладку на странице",
      attr: { type: "button" },
    });
    bmBtn.onclick = () => {
      this.view.toggleBookmarkOnCurrentPage();
      this.render();
    };

    if (this.view.totalPagesNum && this.view.totalPagesNum > 0) {
      const jumpBtn = topActions.createEl("button", {
        cls: "my-epub-appear-action-btn",
        text: `🧭 Перейти к странице (сейчас ${this.view.currentPageNum ?? 1} из ${this.view.totalPagesNum})…`,
        attr: { type: "button" },
      });
      jumpBtn.onclick = () => {
        this.safeClose();
        this.view.openJumpModal();
      };
    }

    const fontSec = contentEl.createDiv("my-epub-appear-section");
    fontSec.createDiv({
      cls: "my-epub-appear-label",
      text: `Размер шрифта: ${s.fontSize}%`,
    });
    const fontRow = fontSec.createDiv("my-epub-appear-chips");
    const decFontBtn = fontRow.createEl("button", {
      cls: "my-epub-appear-chip",
      text: "A− Уменьшить",
      attr: { type: "button" },
    });
    decFontBtn.onclick = () => {
      this.view.setFont(-10);
      this.render();
    };
    const resetFontBtn = fontRow.createEl("button", {
      cls: "my-epub-appear-chip" + (s.fontSize === 120 ? " is-active" : ""),
      text: "120% (Сброс)",
      attr: { type: "button" },
    });
    resetFontBtn.onclick = () => {
      s.fontSize = 120;
      this.view.applyStylesAndRestore();
      this.view.plugin.requestSaveSettings();
      new Notice("Размер шрифта: 120%");
      this.render();
    };
    const incFontBtn = fontRow.createEl("button", {
      cls: "my-epub-appear-chip",
      text: "A+ Увеличить",
      attr: { type: "button" },
    });
    incFontBtn.onclick = () => {
      this.view.setFont(10);
      this.render();
    };

    this.renderChipGroup<ThemeMode>(
      contentEl,
      "Цветовая тема",
      [
        { id: "auto", label: "🌗 Авто (Obsidian)" },
        { id: "sepia", label: "📜 Сепия" },
        { id: "night", label: "🌙 Ночь" },
      ],
      (id) => curTheme === id,
      (id, label) => {
        s.themeMode = id;
        this.view.updateThemeBtnText();
        this.view.applyStyles();
        this.view.plugin.requestSaveSettings();
        new Notice(`Тема: ${label}`);
      }
    );

    this.renderChipGroup<SpreadMode>(
      contentEl,
      "Книжный разворот",
      [
        { id: "none", label: "📄 1 страница" },
        { id: "auto", label: "📖 2 страницы (на широком экране)" },
      ],
      (id) => curSpread === id,
      (id, label) => {
        this.view.applySpreadMode(id);
        this.view.plugin.requestSaveSettings();
        new Notice(`Разворот: ${label}`);
      }
    );

    this.renderChipGroup<FontFamily>(
      contentEl,
      "Шрифт",
      [
        { id: "serif", label: "Georgia (С засечками)" },
        { id: "sans", label: "Без засечек" },
        { id: "default", label: "Из книги" },
        { id: "mono", label: "Моноширинный" },
      ],
      (id) => curFont === id,
      (id, label) => {
        s.fontFamily = id;
        this.view.applyStylesAndRestore();
        this.view.plugin.requestSaveSettings();
        new Notice(`Шрифт: ${label}`);
      }
    );

    this.renderChipGroup<number>(
      contentEl,
      "Межстрочный интервал",
      [
        { id: 1.35, label: "Плотный (1.35)" },
        { id: 1.6, label: "Комфортный (1.6)" },
        { id: 1.85, label: "Свободный (1.85)" },
      ],
      (id) => Math.abs(curLh - id) < 0.05,
      (id, label) => {
        s.lineHeight = id;
        this.view.applyStylesAndRestore();
        this.view.plugin.requestSaveSettings();
        new Notice(`Интервал: ${label}`);
      }
    );

    this.renderChipGroup<number>(
      contentEl,
      "Боковые поля страницы",
      [
        { id: 6, label: "Узкие (6 px)" },
        { id: 12, label: "Стандартные (12 px)" },
        { id: 28, label: "Широкие (28 px)" },
      ],
      (id) => Math.abs(curMargin - id) <= 2,
      (id, label) => {
        s.pageMarginPx = id;
        this.view.applyStylesAndRestore();
        this.view.plugin.requestSaveSettings();
        new Notice(`Поля: ${label}`);
      }
    );

    const alignSec = contentEl.createDiv("my-epub-appear-section");
    alignSec.createDiv({ cls: "my-epub-appear-label", text: "Выравнивание и переносы" });
    const alignRow = alignSec.createDiv("my-epub-appear-chips");

    const aligns: Array<{ id: TextAlignMode; label: string }> = [
      { id: "default", label: "По умолчанию" },
      { id: "justify", label: "По ширине" },
      { id: "left", label: "По левому краю" },
    ];
    for (const al of aligns) {
      const btn = alignRow.createEl("button", {
        cls: "my-epub-appear-chip" + (curAlign === al.id ? " is-active" : ""),
        text: al.label,
        attr: { type: "button" },
      });
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        s.textAlign = al.id;
        this.view.applyStylesAndRestore();
        this.view.plugin.requestSaveSettings();
        new Notice(`Выравнивание: ${al.label}`);
        this.render();
      };
    }

    const hyphBtn = alignRow.createEl("button", {
      cls: "my-epub-appear-chip" + (curHyphens ? " is-active" : ""),
      text: curHyphens ? "✓ Переносы слов" : "Переносы слов",
      attr: { type: "button" },
    });
    hyphBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      s.hyphens = !curHyphens;
      this.view.applyStylesAndRestore();
      this.view.plugin.requestSaveSettings();
      new Notice(s.hyphens ? "Переносы слов включены" : "Переносы слов выключены");
      this.render();
    };

    if (Platform.isDesktop) {
      this.renderChipGroup<number>(
        contentEl,
        "Ширина текста (ПК)",
        [
          { id: 65, label: "65%" },
          { id: 75, label: "75%" },
          { id: 85, label: "85%" },
          { id: 100, label: "100%" },
        ],
        (id) => Math.abs(curWidth - id) < 3,
        (id, label) => {
          s.desktopWidthPct = id;
          this.view.applyDesktopWidth(true);
          this.view.plugin.requestSaveSettings();
          new Notice(`Ширина (ПК): ${label}`);
        }
      );
    }

    this.renderChipGroup<PageAnimation>(
      contentEl,
      "Анимация перелистывания",
      [
        { id: "slide", label: "Слайд" },
        { id: "fade", label: "Мягкое затухание" },
        { id: "none", label: "Выключена" },
      ],
      (id) => curAnim === id,
      (id, label) => {
        s.pageAnimation = id;
        this.view.plugin.requestSaveSettings();
        new Notice(`Анимация: ${label}`);
      }
    );

    this.renderChipGroup<BarPosition>(
      contentEl,
      "Положение панели кнопок",
      [
        { id: "bottom", label: "Снизу" },
        { id: "top", label: "Сверху" },
      ],
      (id) => curPos === id,
      (id, label) => {
        s.barPosition = id;
        this.view.isResizing = true;
        this.view.applyBarPosition();
        this.view.plugin.requestSaveSettings();
        this.view.triggerResize(true);
        new Notice(`Панель: ${label}`);
      }
    );

    contentEl.scrollTop = prevScrollTop;
  }

  onClose() {
    this.contentEl.empty();
  }
}

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
  userHasNavigated = false;
  progressPersistenceBlocked = false;
  pendingOpenCfi: string | null = null;
  navigationInFlight = false;
  activeBookFile: TFile | null = null;
  isClosing = false;
  private closingTask: Promise<void> | null = null;
  private navigationRevision = 0;
  private navigationQueue: Promise<unknown> = Promise.resolve();
  private yamlWriteQueue: Promise<void> = Promise.resolve();
  ExplicitCfiJumpPending = false;
  lastBoxWidth = 0;
  lastBoxHeight = 0;
  loadId = 0;
  cleanupListeners: Array<() => void> = [];

  navHistory: NavHistoryItem[] = [];

  capturedWord = "";
  capturedQuote = "";
  capturedCfi: string | null = null;
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
    if (this.closingTask) await this.closingTask;
    else if (this.book && this.activeBookFile) await this.finishReading();
    else await this.flushYamlProgress();
    this.cleanupView();
    this.isClosing = false;
    this.closingTask = null;
    this.activeBookFile = file;
    const currentLoadId = ++this.loadId;

    await this.plugin.reloadSettingsFromDisk();
    if (currentLoadId !== this.loadId || this.isClosing) return;

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
    this.userHasNavigated = false;
    this.progressPersistenceBlocked = false;
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
    this.stableCfi = toNavigationCfi(this.pendingOpenCfi) ?? initialPos.cfi;
    const rawLocalPosition: unknown = this.plugin.settings.progress[file.path];
    const initialLinkedBook = this.linkedBookNote as BookNoteInfo | null;
    const rawYamlPosition: unknown = initialLinkedBook
      ? this.app.metadataCache.getFileCache(initialLinkedBook.file)?.frontmatter?.["позиция"] : null;
    if (!this.stableCfi &&
        ((typeof rawLocalPosition === "string" && rawLocalPosition.trim()) ||
         (typeof rawYamlPosition === "string" && rawYamlPosition.trim()))) {
      this.progressPersistenceBlocked = true;
      new Notice("Сохранённый адрес позиции повреждён. Прежний прогресс не будет перезаписан, пока ты не выберешь страницу.");
    }
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
      if (currentLoadId !== this.loadId || this.isClosing) return;

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
      fontBtn.onclick = () => this.openTypographyMenu();

      this.rendition.on("relocated", (loc: EpubRelocatedEvent) => {
        if (currentLoadId === this.loadId) this.onRelocated(file, loc);
      });

      try {
        await this.rendition.display(this.stableCfi || undefined);
      } catch {
        if (currentLoadId !== this.loadId || this.isClosing || !this.rendition) return;
        if (this.stableCfi) {
          this.progressPersistenceBlocked = true;
          new Notice("Сохранённая позиция недоступна. Открыто начало книги без перезаписи прогресса; выбери нужную страницу.");
        }
        this.stableCfi = null;
        await this.rendition.display();
      }

      if (currentLoadId !== this.loadId || this.isClosing) return;

      this.lastBoxWidth = this.boxEl.clientWidth;
      this.lastBoxHeight = this.boxEl.clientHeight;
      this.setupResizeObserver();
      this.startReadingTimer();

      await this.book.ready;
      if (currentLoadId !== this.loadId || this.isClosing || !this.book) return;

      try {
        const bookExt = this.book as unknown as EpubBookExtended;
        const meta = await bookExt.loaded?.metadata;
        if (currentLoadId !== this.loadId || this.isClosing) return;
        if (meta?.title) this.bookTitleMeta = String(meta.title).trim();
        if (meta?.creator) this.bookAuthorMeta = String(meta.creator).trim();
      } catch {
        // Игнорируем
      }

      this.trySilentResolveLinkedBookNote(file);
      await this.refreshBookHighlights();
      if (currentLoadId !== this.loadId || this.isClosing || !this.book || !this.rendition) return;

      const loadedFromCache = await tryLoadCachedLocations(this, file, currentLoadId);
      if (currentLoadId !== this.loadId || this.isClosing || !this.book || !this.rendition) return;

      const rendExt = this.rendition as unknown as EpubRenditionExtended;
      const cur = rendExt.currentLocation?.();
      if (!this.navigationInFlight && cur?.start?.cfi) {
        captureChapterMetricsFromLoc(this, cur);
        if (!this.stableCfi || this.userHasNavigated) this.stableCfi = cur.start.cfi;
        this.updateProgressLabels(this.stableCfi);
      }

      if (loadedFromCache) {
        await reconcilePositionWithBookNote(this, file, currentLoadId);
        if (currentLoadId !== this.loadId || this.isClosing) return;
        this.finishInitialPositionRestore();
      } else {
        this.isGeneratingLocations = true;
        if (this.stableCfi) this.updateProgressLabels(this.stableCfi);
        void generateLocationsInBackground(this, file, currentLoadId);
      }
    } catch (err: unknown) {
      if (currentLoadId !== this.loadId || this.isClosing) return;
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
    if (!await this.jumpToCfi(prev.cfi, false)) {
      this.navHistory.push(prev);
      this.updateBackPillState();
    }
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
      new Notice(this.isGeneratingLocations
        ? "Номера страниц ещё готовятся. Подожди немного."
        : "Номера страниц недоступны. Переоткрой книгу для повторной попытки.");
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
        const targetCfi = getCfiFromPageNumberSafe(this, targetPage);
        if (targetCfi) {
          void this.jumpToCfi(targetCfi, true);
        }
      }
    ).open();
  }

  async jumpToCfi(cfi: string, recordHistory = false): Promise<boolean> {
    const navCfi = toNavigationCfi(cfi);
    if (!navCfi) {
      new Notice("Не удалось прочитать позицию в книге. Переход отменён.");
      return false;
    }
    return this.navigateTo(navCfi, recordHistory);
  }

  private async navigateTo(target: string, recordHistory = false): Promise<boolean> {
    if (this.isClosing) return false;
    const rendition = this.rendition;
    const file = this.file;
    if (!rendition || !file) {
      new Notice("Книга ещё не готова к переходу. Дождись загрузки и повтори.");
      return false;
    }
    const loadId = this.loadId;
    const revision = ++this.navigationRevision;
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.isResizing = false;
    this.userHasNavigated = true;
    this.navigationInFlight = true;
    this.ExplicitCfiJumpPending = true;
    this.recordReadingActivity();
    const isCurrent = () => loadId === this.loadId &&
      rendition === this.rendition && revision === this.navigationRevision;
    const run = async (): Promise<boolean> => {
      if (!isCurrent()) return false;
      const previous = this.stableCfi && this.currentPageNum !== null
        ? { cfi: this.stableCfi, page: this.currentPageNum } : null;
      try {
        await withNavigationTimeout(rendition.display(target));
        if (!isCurrent()) return false;
        const loc = (rendition as unknown as EpubRenditionExtended).currentLocation?.();
        const actualCfi = toNavigationCfi(loc?.start?.cfi);
        if (!actualCfi) throw new Error("Читалка не подтвердила новую позицию");
        if (recordHistory && previous) {
          const last = this.navHistory[this.navHistory.length - 1];
          if (last?.cfi !== previous.cfi) this.navHistory.push(previous);
          if (this.navHistory.length > 10) this.navHistory.shift();
          this.updateBackPillState();
        }
        const nowIso = new Date().toISOString();
        this.stableCfi = actualCfi;
        this.progressPersistenceBlocked = false;
        this.pendingOpenCfi = null;
        this.lastLocalPositionSavedAt = nowIso;
        this.plugin.setLocalBookProgress(file.path, actualCfi, nowIso);
        if (loc) captureChapterMetricsFromLoc(this, loc);
        this.updateProgressLabels(actualCfi);
        if (this.isInitialLoadDone) this.requestYamlProgressSync();
        return true;
      } catch (error: unknown) {
        if (isCurrent()) {
          this.progressPersistenceBlocked = true;
          new Notice(`Не удалось перейти: ${getErrorMessage(error)}. Прежний прогресс не перезаписан.`);
        }
        return false;
      } finally {
        if (isCurrent()) {
          this.ExplicitCfiJumpPending = false;
          this.navigationInFlight = false;
        }
      }
    };
    const task = this.navigationQueue.then(run, run);
    this.navigationQueue = task;
    return task;
  }

  clearCapturedSelection() {
    this.capturedWord = "";
    this.capturedQuote = "";
    this.capturedCfi = null;
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

  finishInitialPositionRestore() {
    if (this.isClosing) return;
    this.isInitialLoadDone = true;
    this.recordReadingActivity();
    if (!this.navigationInFlight) this.ExplicitCfiJumpPending = false;
    const file = this.activeBookFile ?? this.file;
    const cfi = toNavigationCfi(this.stableCfi);
    if (file && cfi && !this.progressPersistenceBlocked && !this.navigationInFlight) {
      // Merely reopening must keep the chosen anchor and its original timestamp.
      const savedAt = this.lastLocalPositionSavedAt ||
        this.plugin.settings.progressUpdatedAt?.[file.path] || new Date().toISOString();
      this.lastLocalPositionSavedAt = savedAt;
      this.plugin.setLocalBookProgress(file.path, cfi, savedAt);
    }
    this.requestYamlProgressSync();
  }

  requestYamlProgressSync() {
    if (!this.isInitialLoadDone || this.progressPersistenceBlocked || this.isClosing) return;
    const file = this.activeBookFile ?? this.file;
    if (!this.linkedBookNote || !file) return;
    if (this.linkedBookNote.linkedEpubPath !== file.path) return;
    if (!this.stableCfi) return;

    this.pendingYamlSync = true;
    if (this.yamlSyncTimer) window.clearTimeout(this.yamlSyncTimer);
    this.yamlSyncTimer = window.setTimeout(() => {
      this.yamlSyncTimer = null;
      void this.flushYamlProgress();
    }, YAML_SYNC_DEBOUNCE_MS);
  }

  async flushYamlProgress() {
    const task = this.yamlWriteQueue.then(() => flushBookYamlProgress(this));
    this.yamlWriteQueue = task.catch((error: unknown) => {
      console.error("MyEpubPlugin YAML write queue:", error);
    });
    await this.yamlWriteQueue;
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
    book: BookNoteInfo,
    all: BookNoteInfo[]
  ) {
    const modal = new AddWordModal(this.app, this.plugin, word, cfi, book, all);
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
    this.clearCapturedSelection();

    new QuickTranslateModal(this.app, textToLookup, (chosenWord) => {
      this.capturedWord = chosenWord;
      this.capturedCfi = cfiToSave;
      this.openWordFlowWithExplicitWord(chosenWord, cfiToSave);
    }).open();
  }

  openWordFlowWithExplicitWord(wordToSave: string, cfiToSave: string | null) {
    if (!this.file) return;
    const folder = this.plugin.settings.booksFolder || "Знания/Книги";
    const { exactByProp, all } = findMatchingBookNotes(this.app, this.file, folder);

    if (exactByProp.length === 1 && exactByProp[0]) {
      this.linkedBookNote = exactByProp[0];
      this.openAddWordModalWithRefresh(wordToSave, cfiToSave, this.linkedBookNote, all);
      return;
    }

    this.openBookLinkModal((resolvedBook) => {
      const updatedAll = loadBookNotesFromVault(this.app, folder);
      this.openAddWordModalWithRefresh(wordToSave, cfiToSave, resolvedBook, updatedAll);
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
    this.clearCapturedSelection();
    this.openWordFlowWithExplicitWord(wordToSave, cfiToSave);
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
    if (!this.rendition || this.ExplicitCfiJumpPending || this.isClosing) return;
    this.navigationRevision++;
    this.userHasNavigated = true;
    this.progressPersistenceBlocked = false;
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
      void this.rendition.next().catch((error: unknown) => new Notice(`Не удалось перелистнуть: ${getErrorMessage(error)}`));
    } else {
      void this.rendition.prev().catch((error: unknown) => new Notice(`Не удалось перелистнуть: ${getErrorMessage(error)}`));
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
        void this.navigateTo(href, true);
      },
      onJumpCfi: (cfi) => {
        void this.jumpToCfi(cfi, true);
      },
      onToggleBookmark: () => this.toggleBookmarkOnCurrentPage(),
      onDeleteBookmark: (cfi) => this.deleteBookmarkByCfi(cfi),
    }).open();
  }

  openTypographyMenu() {
    this.recordReadingActivity();
    this.prepareMainWindowFocusBeforeModal();
    new AppearanceModal(this.app, this).open();
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
    if (!this.boxEl || !this.rendition || this.ExplicitCfiJumpPending || this.isClosing) return;

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
    const rendition = this.rendition;
    const loadId = this.loadId;
    const revision = this.navigationRevision;
    const isCurrent = () => rendition === this.rendition &&
      loadId === this.loadId && revision === this.navigationRevision;
    this.isResizing = true;
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);

    this.resizeTimer = window.setTimeout(() => {
      if (!isCurrent()) return;
      if (!this.boxEl) {
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

      rendition.resize(w, h);

      this.resizeTimer = window.setTimeout(async () => {
        if (!isCurrent()) {
          return;
        }
        if (savedAnchor) {
          try {
            await rendition.display(savedAnchor);
          } catch {
            // Игнорируем
          }
        }
        window.setTimeout(() => {
          if (!isCurrent()) return;
          this.isResizing = false;
          if (this.file && this.stableCfi) {
            const rendExt = this.rendition as unknown as EpubRenditionExtended | null;
            const cur = rendExt?.currentLocation?.();
            if (cur?.start) captureChapterMetricsFromLoc(this, cur);
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
    if (!this.rendition || this.isClosing) return;
    if (this.ExplicitCfiJumpPending) {
      const loadId = this.loadId;
      void this.navigationQueue.then(() => {
        if (loadId === this.loadId) this.applyStylesAndRestore();
      });
      return;
    }
    const targetCfi = this.stableCfi;
    const rendition = this.rendition;
    const loadId = this.loadId;
    const revision = this.navigationRevision;
    const isCurrent = () => rendition === this.rendition &&
      loadId === this.loadId && revision === this.navigationRevision;
    this.isResizing = true;
    this.applyStyles();
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(async () => {
      if (!isCurrent()) return;
      if (targetCfi) {
        try {
          await rendition.display(targetCfi);
        } catch {
          // Игнорируем
        }
      }
      window.setTimeout(() => {
        if (!isCurrent()) return;
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
    new Notice(`Размер шрифта: ${s.fontSize}%`);
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

    if (Number.isInteger(total) && total > 0) {
      const idx = Number(this.book.locations.locationFromCfi(cfi));
      const fraction = this.book.locations.percentageFromCfi(cfi);
      if (!Number.isFinite(idx) || idx < 0 || !Number.isFinite(fraction)) return;
      const page = Math.max(1, Math.min(total, idx + 1));
      const pct = Math.max(
        0,
        Math.min(100, Math.round(fraction * 100))
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
    if (this.isClosing || (this.activeBookFile ?? this.file)?.path !== file.path) return;
    if (!this.containerEl.isConnected) return;
    if (this.boxEl && (!this.boxEl.isConnected ||
        this.boxEl.clientWidth <= 0 || this.boxEl.clientHeight <= 0)) return;
    const cfi = loc?.start?.cfi;
    if (!cfi || !this.book) return;

    if (this.isResizing || this.ExplicitCfiJumpPending) return;
    // Opening, font reflow and delayed startup reports are not reading
    // navigation. Preserve the resume anchor until an actual navigation action.
    if (!this.userHasNavigated) return;

    this.recordReadingActivity();
    captureChapterMetricsFromLoc(this, loc);
    this.stableCfi = cfi;

    if (this.progressPersistenceBlocked) {
      this.updateProgressLabels(cfi);
      return;
    }
    const nowIso = new Date().toISOString();
    this.lastLocalPositionSavedAt = nowIso;
    this.plugin.setLocalBookProgress(file.path, cfi, nowIso);

    this.updateProgressLabels(cfi);
    this.requestYamlProgressSync();
  }

  cleanupView() {
    this.loadId++;
    this.navigationRevision++;
    this.navigationQueue = Promise.resolve();
    this.navigationInFlight = false;
    this.ExplicitCfiJumpPending = Boolean(this.pendingOpenCfi);
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
    this.activeBookFile = null;
  }

  private finishReading(): Promise<void> {
    if (this.closingTask) return this.closingTask;
    // Freeze before the first await: detached/resized iframes can emit one last
    // relocated event while Obsidian is closing a tab or changing its file.
    this.isClosing = true;
    this.navigationRevision++;
    this.navigationInFlight = false;
    this.ExplicitCfiJumpPending = false;
    this.isResizing = false;
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    const file = this.activeBookFile ?? this.file;
    const cfi = toNavigationCfi(this.stableCfi);
    if (file && cfi && (this.isInitialLoadDone || this.userHasNavigated) &&
        !this.progressPersistenceBlocked) {
      const savedAt = this.lastLocalPositionSavedAt ||
        this.plugin.settings.progressUpdatedAt?.[file.path] || new Date().toISOString();
      this.lastLocalPositionSavedAt = savedAt;
      this.plugin.setLocalBookProgress(file.path, cfi, savedAt);
      this.pendingYamlSync = true;
    }
    this.closingTask = (async () => {
      await this.flushYamlProgress();
      this.cleanupView();
      await this.plugin.flushSaveSettings();
    })();
    return this.closingTask;
  }

  async onUnloadFile() {
    await this.finishReading();
  }

  async onClose() {
    await this.finishReading();
  }
}
