import { Notice, TFile } from "obsidian";
import { toNavigationCfi } from "./navigation";
import { NavItem } from "epubjs";
import { getTodayISO } from "./modals";
import {
  EpubBookExtended,
  EpubLocationsExtended,
  EpubRelocatedEvent,
  EpubRenditionExtended,
  READING_IDLE_PAUSE_MS,
} from "./settings";
import type { EpubView } from "./view";

export function formatDurationMinutes(minutesFloat: number): string {
  const mins = Math.max(1, Math.round(minutesFloat));
  if (mins < 60) return `~${mins} мин`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `~${h} ч ${m} мин` : `~${h} ч`;
}

export function accrueActiveReadingTime(view: EpubView, now = Date.now()) {
  if (!view.isInitialLoadDone || !view.lastReadingTickAt || !view.lastActivityAt) {
    view.lastReadingTickAt = now;
    return;
  }
  if (document.visibilityState === "hidden") {
    view.lastReadingTickAt = now;
    return;
  }
  const activeLeafView = view.app.workspace.activeLeaf?.view;
  if (activeLeafView !== view) {
    view.lastReadingTickAt = now;
    return;
  }
  if (now - view.lastActivityAt <= READING_IDLE_PAUSE_MS) {
    const deltaSec = Math.max(0, Math.min(60, (now - view.lastReadingTickAt) / 1000));
    view.unsavedReadingSeconds += deltaSec;
  }
  view.lastReadingTickAt = now;
}

export function recordPageTransitionForPace(view: EpubView) {
  const now = Date.now();
  if (view.lastTransitionTimestamp > 0) {
    const dt = now - view.lastTransitionTimestamp;
    if (dt >= 3000 && dt <= 180_000) {
      view.turnDurationsMs.push(dt);
      if (view.turnDurationsMs.length > 10) {
        view.turnDurationsMs.shift();
      }
    }
  }
  view.lastTransitionTimestamp = now;
}

export function findTocLabelByHref(items: NavItem[], cleanHref: string): string {
  for (const it of items) {
    const itemHref = (it.href || "").split("#")[0] || "";
    if (
      itemHref &&
      (itemHref === cleanHref || cleanHref.endsWith(itemHref) || itemHref.endsWith(cleanHref))
    ) {
      return (it.label || "").trim();
    }
    if (it.subitems && it.subitems.length > 0) {
      const subFound = findTocLabelByHref(it.subitems, cleanHref);
      if (subFound) return subFound;
    }
  }
  return "";
}

export function computeFastPercentage(
  view: EpubView,
  cfi: string,
  loc?: EpubRelocatedEvent
): number {
  if (!view.book) return view.approxProgressPct ?? 0;

  if (view.book.locations && view.book.locations.length() > 0) {
    const p = view.book.locations.percentageFromCfi(cfi);
    if (typeof p === "number" && Number.isFinite(p)) {
      return Math.max(0, Math.min(100, Math.round(p * 100)));
    }
  }

  const rendExt = view.rendition as unknown as EpubRenditionExtended | null;
  const start = loc?.start ?? rendExt?.currentLocation?.()?.start;
  const bookExt = view.book as unknown as EpubBookExtended;
  const spineLen = bookExt.spine?.spineItems?.length || 0;

  if (start && typeof start.index === "number" && spineLen > 0) {
    const dispPage = start.displayed?.page ?? 1;
    const dispTotal = Math.max(1, start.displayed?.total ?? 1);
    const frac = (start.index + (dispPage - 1) / dispTotal) / spineLen;
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    view.approxProgressPct = pct;
    return pct;
  }

  return view.approxProgressPct ?? 0;
}

export function captureChapterMetricsFromLoc(view: EpubView, loc: EpubRelocatedEvent) {
  const disp = loc?.start?.displayed;
  if (disp && typeof disp.page === "number" && typeof disp.total === "number" && disp.total > 0) {
    view.chapterPageCurrent = disp.page;
    view.chapterPageTotal = disp.total;
  } else {
    view.chapterPageCurrent = null;
    view.chapterPageTotal = null;
  }

  computeFastPercentage(view, loc?.start?.cfi || "", loc);

  const href: string = loc?.start?.href || "";
  if (href && view.book?.navigation?.toc) {
    const cleanHref = href.split("#")[0] || "";
    const found = findTocLabelByHref(view.book.navigation.toc, cleanHref);
    if (found) view.currentChapterTitle = found;
  }
}

export function buildChapterSummaryText(view: EpubView): string {
  const parts: string[] = [];
  if (view.currentChapterTitle) parts.push(`Глава: «${view.currentChapterTitle}»`);

  const hasPaceData = view.turnDurationsMs.length >= 3;
  const avgTurnMs = hasPaceData
    ? view.turnDurationsMs.reduce((acc, v) => acc + v, 0) / view.turnDurationsMs.length
    : 0;

  if (view.chapterPageCurrent !== null && view.chapterPageTotal !== null) {
    const leftInChapter = Math.max(0, view.chapterPageTotal - view.chapterPageCurrent);
    if (leftInChapter === 0) {
      parts.push(`последняя страница главы (${view.chapterPageCurrent}/${view.chapterPageTotal})`);
    } else {
      const etaChapter =
        hasPaceData && avgTurnMs > 0
          ? `, ${formatDurationMinutes((leftInChapter * avgTurnMs) / 60_000)}`
          : "";
      parts.push(
        `до конца главы: ${leftInChapter} стр.${etaChapter} (${view.chapterPageCurrent} из ${view.chapterPageTotal})`
      );
    }
  }

  if (
    hasPaceData &&
    avgTurnMs > 0 &&
    view.currentPageNum !== null &&
    view.totalPagesNum !== null &&
    view.totalPagesNum > view.currentPageNum
  ) {
    const leftInBook = view.totalPagesNum - view.currentPageNum;
    parts.push(`до конца книги: ${formatDurationMinutes((leftInBook * avgTurnMs) / 60_000)}`);
  }

  return parts.join(" · ");
}

export function getCfiFromPageNumberSafe(view: EpubView, page: number): string | null {
  if (!view.book || !Number.isInteger(page) || !Number.isInteger(view.totalPagesNum) ||
      !view.totalPagesNum || view.totalPagesNum <= 0) return null;
  if (page < 1 || page > view.totalPagesNum) return null;
  const total = view.totalPagesNum;
  const clampedPage = Math.max(1, Math.min(total, Math.round(page)));
  const idx = clampedPage - 1;
  const locs = view.book.locations as unknown as EpubLocationsExtended;

  if (typeof locs.cfiFromLocation === "function") {
    try {
      const cfi = locs.cfiFromLocation(idx);
      const target = toNavigationCfi(cfi);
      if (target) return target;
    } catch {
      // Игнорируем
    }
  }

  const fromArr = locs._locations?.[idx];
  const fromArray = toNavigationCfi(fromArr);
  if (fromArray) return fromArray;

  try {
    return toNavigationCfi(view.book.locations.cfiFromPercentage(
      Math.max(0, Math.min(1, idx / Math.max(1, total - 1)))
    ));
  } catch { return null; }
}

export function getCfiFromPageNumber(view: EpubView, page: number): string | null {
  return getCfiFromPageNumberSafe(view, page);
}

export function resolveInitialCfiBeforeRender(
  view: EpubView,
  file: TFile
): { cfi: string | null; savedAt: string | null } {
  const localCfi = toNavigationCfi(view.plugin.settings.progress[file.path]);
  const localTimeStr = view.plugin.settings.progressUpdatedAt?.[file.path] || null;

  if (view.ExplicitCfiJumpPending || !view.linkedBookNote) {
    return { cfi: localCfi, savedAt: localTimeStr };
  }

  const fm = view.app.metadataCache.getFileCache(view.linkedBookNote.file)?.frontmatter;
  if (!fm) return { cfi: localCfi, savedAt: localTimeStr };

  const rawYamlCfi = typeof fm["позиция"] === "string" ? fm["позиция"].trim() : "";
  const yamlCfi = toNavigationCfi(rawYamlCfi);
  const yamlTimeStr =
    typeof fm["позиция_время"] === "string" && fm["позиция_время"].trim()
      ? fm["позиция_время"].trim()
      : null;

  const rawPct = fm["прогресс"];
  if (rawPct !== undefined && rawPct !== null && String(rawPct).trim() !== "") {
    const n = Number(rawPct);
    if (Number.isFinite(n) && n >= 0 && n <= 100) {
      view.approxProgressPct = Math.round(n);
    }
  }

  if (!yamlCfi) {
    return { cfi: localCfi, savedAt: localTimeStr };
  }

  const yamlMs = yamlTimeStr ? Date.parse(yamlTimeStr) : NaN;
  const localMs = localTimeStr ? Date.parse(localTimeStr) : NaN;

  if (localCfi && Number.isFinite(yamlMs) && Number.isFinite(localMs)) {
    if (yamlMs > localMs) {
      return { cfi: yamlCfi, savedAt: yamlTimeStr };
    }
    return { cfi: localCfi, savedAt: localTimeStr };
  }

  if (localCfi && Number.isFinite(localMs) && !Number.isFinite(yamlMs)) {
    return { cfi: localCfi, savedAt: localTimeStr };
  }
  return { cfi: yamlCfi, savedAt: yamlTimeStr || localTimeStr };
}

export async function tryLoadCachedLocations(
  view: EpubView,
  file: TFile,
  currentLoadId: number
): Promise<boolean> {
  if (!view.book) return false;
  const sig = `${file.stat.mtime}:${file.stat.size}`;
  const cachedJson = await view.plugin.loadLocationsCacheFile(file.path, sig);
  if (currentLoadId !== view.loadId || !view.book || !cachedJson || view.isClosing) return false;

  try {
    const parsed: unknown = JSON.parse(cachedJson);
    if (!Array.isArray(parsed) || !parsed.length ||
        !(parsed as unknown[]).every(cfi => toNavigationCfi(cfi) !== null)) return false;
    view.book.locations.load(cachedJson);
    return view.book.locations.length() > 0;
  } catch {
    return false;
  }
}

export async function generateLocationsInBackground(
  view: EpubView,
  file: TFile,
  currentLoadId: number
) {
  if (!view.book) return;
  const sig = `${file.stat.mtime}:${file.stat.size}`;
  try {
    await view.book.locations.generate(1024);
    if (currentLoadId !== view.loadId || !view.book || !view.rendition || view.isClosing) return;

    view.isGeneratingLocations = false;
    try {
      const serialized = view.book.locations.save();
      if (typeof serialized === "string" && serialized.length > 2) {
        await view.plugin.saveLocationsCacheFile(file.path, sig, serialized);
      }
    } catch {
      // Игнорируем
    }

    if (currentLoadId !== view.loadId || !view.book || !view.rendition || view.isClosing) return;

    const rendExt = view.rendition as unknown as EpubRenditionExtended;
    const cur = rendExt.currentLocation?.();
    if (!view.navigationInFlight && cur?.start?.cfi) {
      captureChapterMetricsFromLoc(view, cur);
      if (!view.stableCfi || view.userHasNavigated) view.stableCfi = cur.start.cfi;
      view.updateProgressLabels(view.stableCfi);
    }

    await reconcilePositionWithBookNote(view, file, currentLoadId);
    if (currentLoadId !== view.loadId) return;

    view.finishInitialPositionRestore();
  } catch {
    if (currentLoadId === view.loadId && !view.isClosing) {
      view.isGeneratingLocations = false;
      view.finishInitialPositionRestore();
      new Notice("Не удалось построить номера страниц. Позиция чтения продолжит сохраняться; переоткрой книгу для повторной попытки.");
    }
  }
}

export async function reconcilePositionWithBookNote(
  view: EpubView,
  file: TFile,
  currentLoadId: number
) {
  if (view.ExplicitCfiJumpPending || view.userHasNavigated || view.progressPersistenceBlocked || view.isClosing) return;
  if (!view.linkedBookNote || !view.book || !view.rendition) return;
  if (!view.totalPagesNum || view.totalPagesNum <= 0) return;

  const fm = view.app.metadataCache.getFileCache(view.linkedBookNote.file)?.frontmatter;
  if (!fm) return;

  const rawYamlCfi = typeof fm["позиция"] === "string" ? fm["позиция"].trim() : "";
  const yamlCfi = toNavigationCfi(rawYamlCfi);
  const yamlTimeStr =
    typeof fm["позиция_время"] === "string" && fm["позиция_время"].trim()
      ? fm["позиция_время"].trim()
      : null;

  const rawYamlRead = fm["прочитано"];
  const hasYamlRead =
    rawYamlRead !== undefined && rawYamlRead !== null && String(rawYamlRead).trim() !== "";
  const parsedYamlPage = hasYamlRead ? Math.round(Number(rawYamlRead)) : NaN;
  const yamlPage =
    Number.isFinite(parsedYamlPage) && parsedYamlPage > 0 && parsedYamlPage <= view.totalPagesNum
      ? parsedYamlPage
      : null;

  const localTimeStr =
    view.lastLocalPositionSavedAt ||
    view.plugin.settings.progressUpdatedAt?.[file.path] ||
    null;
  const yamlMs = yamlTimeStr ? Date.parse(yamlTimeStr) : NaN;
  const localMs = localTimeStr ? Date.parse(localTimeStr) : NaN;
  const hasBothTimes = Number.isFinite(yamlMs) && Number.isFinite(localMs);

  const pickTargetCfiFromYaml = (): string | null => {
    // The CFI anchor takes priority over potentially renumbered page labels.
    if (yamlCfi) return yamlCfi;
    if (yamlPage !== null) {
      return getCfiFromPageNumberSafe(view, yamlPage);
    }
    return null;
  };

  const restore = async (target: string, savedAt: string) => {
    const rendition = view.rendition;
    if (!rendition || currentLoadId !== view.loadId || view.userHasNavigated) return;
    try {
      await rendition.display(target);
      if (currentLoadId !== view.loadId || rendition !== view.rendition || view.userHasNavigated) return;
      view.stableCfi = target;
      view.lastLocalPositionSavedAt = savedAt;
      view.plugin.setLocalBookProgress(file.path, target, savedAt);
      view.updateProgressLabels(target);
    } catch {
      new Notice("Не удалось восстановить позицию из заметки. Текущий прогресс сохранён.");
    }
  };

  if (hasBothTimes) {
    if (localMs >= yamlMs) return;
    if (yamlMs > localMs) {
      const targetCfi = pickTargetCfiFromYaml();
      if (targetCfi && targetCfi !== view.stableCfi && currentLoadId === view.loadId) {
        await restore(targetCfi, yamlTimeStr!);
      }
      return;
    }
    return;
  }

  // With no comparable timestamps, never replace a valid CFI with a page label.
  if (toNavigationCfi(view.stableCfi)) return;
  if (yamlPage !== null || yamlCfi) {
    const targetCfi = pickTargetCfiFromYaml();
    if (targetCfi && currentLoadId === view.loadId) {
      const syncedTime = yamlTimeStr || new Date().toISOString();
      await restore(targetCfi, syncedTime);
    }
  }
}

export async function flushBookYamlProgress(view: EpubView) {
  if (view.yamlSyncTimer) {
    window.clearTimeout(view.yamlSyncTimer);
    view.yamlSyncTimer = null;
  }
  if (view.ExplicitCfiJumpPending || view.isResizing || view.progressPersistenceBlocked) return;

  accrueActiveReadingTime(view, Date.now());
  const addedReadingMinutes = Math.floor(view.unsavedReadingSeconds / 60);

  if (!view.pendingYamlSync && addedReadingMinutes <= 0) return;
  const file = view.activeBookFile ?? view.file;
  if (!view.linkedBookNote || !file) return;
  if (view.linkedBookNote.linkedEpubPath !== file.path) return;

  const noteFile = view.linkedBookNote.file;
  const pageNum = view.currentPageNum;
  const totalNum = view.totalPagesNum;
  const pctNum = view.currentProgressPct ?? view.approxProgressPct;
  const cfiToSync = view.stableCfi;
  const posTimeIso =
    view.lastLocalPositionSavedAt ||
    view.plugin.settings.progressUpdatedAt?.[file.path] ||
    new Date().toISOString();

  if (!cfiToSync) return;
  view.pendingYamlSync = false;

  const todayISO = getTodayISO();
  const fmCache = view.app.metadataCache.getFileCache(noteFile)?.frontmatter;
  if (
    addedReadingMinutes <= 0 &&
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

  if (addedReadingMinutes > 0) {
    view.unsavedReadingSeconds -= addedReadingMinutes * 60;
  }

  try {
    await view.app.fileManager.processFrontMatter(noteFile, (fm: Record<string, unknown>) => {
      if (totalNum !== null && totalNum > 0 && fm["страниц"] !== totalNum) {
        fm["страниц"] = totalNum;
      }
      if (pageNum !== null && pageNum > 0 && fm["прочитано"] !== pageNum) {
        fm["прочитано"] = pageNum;
      }
      if (pctNum !== null && pctNum >= 0 && fm["прогресс"] !== pctNum) {
        fm["прогресс"] = pctNum;
      }
      if (fm["последнее_чтение"] !== todayISO) {
        fm["последнее_чтение"] = todayISO;
      }
      if (fm["позиция"] !== cfiToSync) {
        fm["позиция"] = cfiToSync;
      }
      if (fm["позиция_время"] !== posTimeIso) {
        fm["позиция_время"] = posTimeIso;
      }
      if (addedReadingMinutes > 0) {
        const prevMin = Number(fm["минут_чтения"]);
        const baseMin = Number.isFinite(prevMin) && prevMin >= 0 ? Math.round(prevMin) : 0;
        const nextMin = baseMin + addedReadingMinutes;
        if (fm["минут_чтения"] !== nextMin) {
          fm["минут_чтения"] = nextMin;
        }
      }
      if (!fm["статус"] || fm["статус"] === "В планах") {
        fm["статус"] = "Читаю";
      }
    });
  } catch (e) {
    if (addedReadingMinutes > 0) {
      view.unsavedReadingSeconds += addedReadingMinutes * 60;
    }
    view.pendingYamlSync = true;
    console.error("MyEpubPlugin error syncing YAML frontmatter:", e);
  }
}
