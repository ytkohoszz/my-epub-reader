import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { BookmarkItem } from "./highlights";
import type MyEpubPlugin from "./main";

export const VIEW_TYPE = "my-epub-view";
export const MAX_CACHED_BOOKS = 15;
export const YAML_SYNC_DEBOUNCE_MS = 2000;
export const SELECTION_THROTTLE_MS = 120;
export const READING_IDLE_PAUSE_MS = 120_000;
export const READING_TICK_INTERVAL_MS = 15_000;

export type ThemeMode = "auto" | "sepia" | "night";
export type FontFamily = "default" | "serif" | "sans" | "mono";
export type PageAnimation = "slide" | "fade" | "none";
export type BarPosition = "bottom" | "top";
export type SpreadMode = "none" | "auto";
export type TextAlignMode = "default" | "justify" | "left";

export interface LegacyLocationCacheEntry {
  sig: string;
  locations: string;
  updatedAt: number;
}

export interface LocationIndexMeta {
  fileName: string;
  sig: string;
  updatedAt: number;
}

export interface NavHistoryItem {
  cfi: string;
  page: number;
}

// Локальные интерфейсы для внутренних структур epub.js
export interface EpubDisplayedPage {
  page: number;
  total: number;
}

export interface EpubLocationPoint {
  cfi: string;
  href?: string;
  index?: number;
  displayed?: EpubDisplayedPage;
}

export interface EpubRelocatedEvent {
  start?: EpubLocationPoint;
  end?: EpubLocationPoint;
}

export interface EpubContentsExtended {
  document?: Document;
  window?: Window;
  cfiFromRange?: (range: Range) => string;
}

export interface EpubRenditionExtended {
  getContents?: () => EpubContentsExtended[];
  currentLocation?: () => EpubRelocatedEvent;
}

export interface EpubLocationsExtended {
  _locations?: string[];
  cfiFromLocation?: (index: number) => string;
}

export interface EpubMetadataLoaded {
  title?: string;
  creator?: string;
}

export interface EpubBookExtended {
  loaded?: {
    metadata?: Promise<EpubMetadataLoaded>;
  };
  spine?: {
    spineItems?: unknown[];
  };
}

export interface Settings {
  progress: Record<string, string>;
  progressUpdatedAt?: Record<string, string>;
  fontSize: number;
  themeMode?: ThemeMode;
  fontFamily?: FontFamily;
  lineHeight?: number;
  pageMarginPx?: number;
  textAlign?: TextAlignMode;
  hyphens?: boolean;
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

export const DEFAULTS: Settings = {
  progress: {},
  progressUpdatedAt: {},
  fontSize: 120,
  themeMode: "auto",
  fontFamily: "serif",
  lineHeight: 1.6,
  pageMarginPx: 12,
  textAlign: "default",
  hyphens: false,
  pageAnimation: "slide",
  barPosition: "bottom",
  spreadMode: "none",
  desktopWidthPct: 85,
  bookmarks: {},
  booksFolder: "Знания/Книги",
  wordsFilePath: "Words Cards",
  quotesFilePath: "Знания/Цитаты из книг.md",
};

export const FONT_MAP: Record<FontFamily, string> = {
  default: "inherit",
  serif: "Georgia, 'Times New Roman', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "Неизвестная ошибка");
}

export function migrateSettings(raw: unknown): Settings {
  const source = raw && typeof raw === "object" ? (raw as Partial<Settings>) : {};
  const s: Settings = Object.assign({}, DEFAULTS, source);

  if (!s.progress || typeof s.progress !== "object") s.progress = {};
  if (!s.progressUpdatedAt || typeof s.progressUpdatedAt !== "object") s.progressUpdatedAt = {};
  if (typeof s.fontSize !== "number" || isNaN(s.fontSize)) s.fontSize = DEFAULTS.fontSize;
  if (!s.bookmarks || typeof s.bookmarks !== "object") s.bookmarks = {};
  if (!s.booksFolder || typeof s.booksFolder !== "string") s.booksFolder = DEFAULTS.booksFolder;
  if (!s.wordsFilePath || typeof s.wordsFilePath !== "string") s.wordsFilePath = DEFAULTS.wordsFilePath;
  if (!s.quotesFilePath || typeof s.quotesFilePath !== "string") s.quotesFilePath = DEFAULTS.quotesFilePath;
  if (s.spreadMode !== "auto" && s.spreadMode !== "none") s.spreadMode = "none";
  if (s.themeMode !== "auto" && s.themeMode !== "sepia" && s.themeMode !== "night") s.themeMode = "auto";
  if (typeof s.pageMarginPx !== "number" || isNaN(s.pageMarginPx)) s.pageMarginPx = DEFAULTS.pageMarginPx;
  if (s.textAlign !== "default" && s.textAlign !== "justify" && s.textAlign !== "left") s.textAlign = "default";
  if (typeof s.hyphens !== "boolean") s.hyphens = false;
  if (s.pageAnimation !== "slide" && s.pageAnimation !== "fade" && s.pageAnimation !== "none") {
    s.pageAnimation = "slide";
  }
  if (s.barPosition !== "bottom" && s.barPosition !== "top") s.barPosition = "bottom";
  return s;
}

export function hashBookPathToFileName(bookPath: string): string {
  let h = 2166136261;
  for (let i = 0; i < bookPath.length; i++) {
    h ^= bookPath.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `loc-${hex}.json`;
}

export class EpubSettingTab extends PluginSettingTab {
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
      .setName("Тема читалки")
      .setDesc("Цветовая схема страницы книги")
      .addDropdown((drop) =>
        drop
          .addOption("auto", "Авто (как в Obsidian)")
          .addOption("sepia", "Сепия")
          .addOption("night", "Ночь")
          .setValue(this.plugin.settings.themeMode ?? "auto")
          .onChange((val) => {
            this.plugin.settings.themeMode = val as ThemeMode;
            this.plugin.requestSaveSettings();
            this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName("Поля страницы (px)")
      .setDesc("Боковые внутренние отступы текста книги (по умолчанию: 12 px)")
      .addSlider((slider) =>
        slider
          .setLimits(0, 48, 2)
          .setValue(this.plugin.settings.pageMarginPx ?? 12)
          .setDynamicTooltip()
          .onChange((val) => {
            this.plugin.settings.pageMarginPx = val;
            this.plugin.requestSaveSettings();
            this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName("Выравнивание текста")
      .setDesc("Выравнивание абзацев книги")
      .addDropdown((drop) =>
        drop
          .addOption("default", "По умолчанию (из книги)")
          .addOption("justify", "По ширине")
          .addOption("left", "По левому краю")
          .setValue(this.plugin.settings.textAlign ?? "default")
          .onChange((val) => {
            this.plugin.settings.textAlign = val as TextAlignMode;
            this.plugin.requestSaveSettings();
            this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName("Автоматические переносы слов")
      .setDesc("Включить CSS-переносы (hyphens: auto)")
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(this.plugin.settings.hyphens))
          .onChange((val) => {
            this.plugin.settings.hyphens = val;
            this.plugin.requestSaveSettings();
            this.plugin.refreshAllViews();
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