import { Notice, Plugin, TFile } from "obsidian";
import {
  EpubSettingTab,
  LocationIndexMeta,
  MAX_CACHED_BOOKS,
  Settings,
  VIEW_TYPE,
  hashBookPathToFileName,
  migrateSettings,
} from "./settings";
import { EpubView } from "./view";
import { toNavigationCfi } from "./navigation";

export { EpubView } from "./view";
export type { Settings, LocationIndexMeta } from "./settings";

export default class MyEpubPlugin extends Plugin {
  settings!: Settings;
  private saveTimer: number | null = null;
  private dirty = false;
  private settingsRevision = 0;
  private settingsWriteQueue: Promise<void> = Promise.resolve();
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
      name: "Открыть оглавление, закладки, слова и поиск",
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
      name: "Быстрый перевод без сохранения в словарь",
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

  async initAndMigrateLocationsCache() {
    const adapter = this.app.vault.adapter;
    const indexPath = this.getLocationsIndexPath();

    try {
      if (await adapter.exists(indexPath)) {
        const raw = await adapter.read(indexPath);
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          this.locationsIndex = parsed as Record<string, LocationIndexMeta>;
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
            // Игнорируем
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
      await this.settingsWriteQueue;
      if (this.dirty) return;
      const revision = this.settingsRevision;
      const diskData: unknown = await this.loadData();
      if (diskData && !this.dirty && revision === this.settingsRevision) {
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
    const mode = this.settings.themeMode ?? "auto";
    const isSepia = Boolean(activeView && mode === "sepia");
    const isNight = Boolean(activeView && mode === "night");
    document.body.classList.toggle("my-epub-fullscreen", isFs);
    document.body.classList.toggle("my-epub-sepia-bg", isFs && isSepia);
    document.body.classList.toggle("my-epub-night-bg", isFs && isNight);
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
    if (targetFile.extension.toLowerCase() !== "epub") {
      new Notice("Ссылка должна вести на файл EPUB.");
      return;
    }

    await this.reloadSettingsFromDisk();

    const navCfi = toNavigationCfi(cfi);
    if (cfi && !navCfi) {
      new Notice("Ссылка содержит некорректную позицию в книге. Прогресс не изменён.");
      return;
    }

    const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of existingLeaves) {
      const view = leaf.view;
      if (view instanceof EpubView && view.file?.path === targetFile.path) {
        if (navCfi) view.ExplicitCfiJumpPending = true;
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        try {
          if (navCfi) await view.jumpToCfi(navCfi, true);
        } finally {
          if (!view.navigationInFlight) view.ExplicitCfiJumpPending = false;
        }
        return;
      }
    }

    const leaf = this.app.workspace.getLeaf(false);
    if (navCfi) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      if (leaf.view instanceof EpubView) {
        leaf.view.pendingOpenCfi = navCfi;
      }
    }
    try {
      await leaf.openFile(targetFile);
      if (navCfi && leaf.view instanceof EpubView) {
        await leaf.view.jumpToCfi(navCfi, false);
      }
    } finally {
      if (leaf.view instanceof EpubView) {
        leaf.view.pendingOpenCfi = null;
        if (!leaf.view.navigationInFlight) leaf.view.ExplicitCfiJumpPending = false;
      }
    }
  }

  refreshAllViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof EpubView) {
        view.updateThemeBtnText();
        view.applyBarPosition();
        view.applySpreadMode(this.settings.spreadMode ?? "none");
        view.applyDesktopWidth(true);
        view.applyStylesAndRestore();
      }
    }
  }

  requestSaveSettings() {
    this.settingsRevision++;
    this.dirty = true;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushSaveSettings();
    }, 400);
  }

  async flushSaveSettings() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.dirty = false;
      const snapshot = JSON.parse(JSON.stringify(this.settings)) as Settings;
      const write = this.settingsWriteQueue.then(() => this.saveData(snapshot));
      this.settingsWriteQueue = write.catch(() => {
        this.dirty = true;
        new Notice("Не удалось сохранить настройки читалки. Изменения будут сохранены повторно.");
      });
    }
    await this.settingsWriteQueue;
  }

  saveSettings() {
    this.requestSaveSettings();
  }

  onunload() {
    document.body.classList.remove("my-epub-fullscreen", "my-epub-sepia-bg", "my-epub-night-bg");
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
