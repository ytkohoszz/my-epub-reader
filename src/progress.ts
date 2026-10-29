import { TFile } from "obsidian";
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
  if (
    disp &&
    typeof disp.page === "number" &&
    typeof disp.total === "number" &&
    disp.total > 0
  ) {
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
      parts.push(
        `последняя страница главы (${view.chapterPageCurrent}/${view.chapterPageTotal})`
      );
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

export function getCfiFromPageNumber(view: EpubView, page: number): string | null {
  if (!view.book || !view.totalPagesNum || view.totalPagesNum <= 0) return null;
  const clampedPage = Math.max(1, Math.min(view.totalPagesNum, Math.round(page)));
  const idx = clampedPage - 1;
  const locs = view.book.locations as unknown as EpubLocationsExtended;

  if (typeof locs.cfiFromLocation === "function") {
    try {
      const cfi = locs.cfiFromLocation(idx);
      if (typeof cfi === "string" && cfi.length > 0) return cfi;
    } catch {
      // Игнорируем
    }
  }

  const fromArr = locs._locations?.[idx];
  if (typeof fromArr === "string" && fromArr.length > 0) return fromArr;

  return view.book.locations.cfiFromPercentage(
    Math.max(0, Math.min(1, idx / Math.max(1, view.totalPagesNum)))
  );
}

export function resolveInitialCfiBeforeRender(
  view: EpubView,
  file: TFile
): { cfi: string | null; savedAt: string | null } {
  const localCfi = view.plugin.settings.progress[file.path] || null;
  const localTimeStr = view.plugin.settings.progressUpdatedAt?.[file.path] || null;

  if (view.ExplicitCfiJumpPending || !view.linkedBookNote) {
    return { cfi: localCfi, savedAt: localTimeStr };
  }

  const fm = view.app.metadataCache.getFileCache(view.linkedBookNote.file)?.frontmatter;
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
      view.approxProgressPct = Math.round(n);
    }
  }

  if (!yamlCfi) {
    return { cfi: localCfi, savedAt: localTimeStr };
  }

  const yamlMs = yamlTimeStr ? Date.parse(yamlTimeStr) : NaN;
  const localMs = localTimeStr ? Date.parse(localTimeStr) : NaN;

  if (Number.isFinite(yamlMs) && Number.isFinite(localMs)) {
    if (yamlMs > localMs) {
      view.plugin.setLocalBookProgress(file.path, yamlCfi, yamlTimeStr!);
      return { cfi: yamlCfi, savedAt: yamlTimeStr };
    }
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
  if (currentLoadId !== view.loadId || !view.book || !cachedJson) return false;

  try {
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
    if (currentLoadId !== view.loadId || !view.book || !view.rendition) return;

    view.isGeneratingLocations = false;
    try {
      const serialized = view.book.locations.save();
      if (typeof serialized === "string" && serialized.length > 2) {
        await view.plugin.saveLocationsCacheFile(file.path, sig, serialized);
      }
    } catch {
      // Игнорируем ошибку сохранения кэша
    }

    if (currentLoadId !== view.loadId || !view.book || !view.rendition) return;

    const rendExt = view.rendition as unknown as EpubRenditionExtended;
    const cur = rendExt.currentLocation?.();
    if (cur?.start?.cfi) {
      captureChapterMetricsFromLoc(view, cur);
      view.stableCfi = cur.start.cfi;
      view.updateProgressLabels(cur.start.cfi);
    }

    await reconcilePositionWithBookNote(view, file, currentLoadId);
    if (currentLoadId !== view.loadId) return;

    view.isInitialLoadDone = true;
    view.ExplicitCfiJumpPending = false;
    view.requestYamlProgressSync();
  } catch {
    if (currentLoadId === view.loadId) {
      view.isGeneratingLocations = false;
    }
  }
}

export async function reconcilePositionWithBookNote(
  view: EpubView,
  file: TFile,
  currentLoadId: number
) {
  if (view.ExplicitCfiJumpPending) return;
  if (!view.linkedBookNote || !view.book || !view.rendition) return;
  if (!view.totalPagesNum || view.totalPagesNum <= 0) return;

  const fm = view.app.metadataCache.getFileCache(view.linkedBookNote.file)?.frontmatter;
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
      ? Math.max(1, Math.min(view.totalPagesNum, parsedYamlPage))
      : null;

  const localTimeStr =
    view.lastLocalPositionSavedAt ||
    view.plugin.settings.progressUpdatedAt?.[file.path] ||
    null;
  const yamlMs = yamlTimeStr ? Date.parse(yamlTimeStr) : NaN;
  const localMs = localTimeStr ? Date.parse(localTimeStr) : NaN;
  const hasBothTimes = Number.isFinite(yamlMs) && Number.isFinite(localMs);

  const localPage = view.currentPageNum ?? 1;

  const pickTargetCfiFromYaml = (): string | null => {
    if (yamlCfi) {
      if (yamlPage !== null) {
        const cfiIdx = Number(view.book!.locations.locationFromCfi(yamlCfi));
        const cfiPage = Math.max(1, Math.min(view.totalPagesNum!, cfiIdx + 1));
        if (Math.abs(cfiPage - yamlPage) >= 1) {
          return getCfiFromPageNumber(view, yamlPage);
        }
      }
      return yamlCfi;
    }
    if (yamlPage !== null) {
      return getCfiFromPageNumber(view, yamlPage);
    }
    return null;
  };

  if (hasBothTimes) {
    if (localMs > yamlMs) return;
    if (yamlMs > localMs) {
      const targetCfi = pickTargetCfiFromYaml();
      if (targetCfi && targetCfi !== view.stableCfi && currentLoadId === view.loadId) {
        view.stableCfi = targetCfi;
        view.lastLocalPositionSavedAt = yamlTimeStr;
        view.plugin.setLocalBookProgress(file.path, targetCfi, yamlTimeStr!);
        try {
          await view.rendition.display(targetCfi);
        } catch {
          // Игнорируем
        }
        view.updateProgressLabels(targetCfi);
      }
      return;
    }
    if (yamlPage !== null && yamlPage !== localPage) {
      const targetCfi = getCfiFromPageNumber(view, yamlPage);
      if (targetCfi && currentLoadId === view.loadId) {
        const nowIso = new Date().toISOString();
        view.stableCfi = targetCfi;
        view.lastLocalPositionSavedAt = nowIso;
        view.plugin.setLocalBookProgress(file.path, targetCfi, nowIso);
        try {
          await view.rendition.display(targetCfi);
        } catch {
          // Игнорируем
        }
        view.updateProgressLabels(targetCfi);
      }
    }
    return;
  }

  if (yamlPage !== null && yamlPage !== localPage) {
    const targetCfi = pickTargetCfiFromYaml();
    if (targetCfi && currentLoadId === view.loadId) {
      const syncedTime = yamlTimeStr || new Date().toISOString();
      view.stableCfi = targetCfi;
      view.lastLocalPositionSavedAt = syncedTime;
      view.plugin.setLocalBookProgress(file.path, targetCfi, syncedTime);
      try {
        await view.rendition.display(targetCfi);
      } catch {
        // Игнорируем
      }
      view.updateProgressLabels(targetCfi);
    }
  } else if (yamlCfi && yamlCfi !== view.stableCfi && !view.stableCfi) {
    const syncedTime = yamlTimeStr || new Date().toISOString();
    view.stableCfi = yamlCfi;
    view.lastLocalPositionSavedAt = syncedTime;
    view.plugin.setLocalBookProgress(file.path, yamlCfi, syncedTime);
    try {
      await view.rendition.display(yamlCfi);
    } catch {
      // Игнорируем
    }
    view.updateProgressLabels(yamlCfi);
  }
}

export async function flushBookYamlProgress(view: EpubView) {
  if (view.yamlSyncTimer) {
    window.clearTimeout(view.yamlSyncTimer);
    view.yamlSyncTimer = null;
  }
  if (view.navHistory.length > 0) return;

  accrueActiveReadingTime(view, Date.now());
  const addedReadingMinutes = Math.floor(view.unsavedReadingSeconds / 60);

  if (!view.pendingYamlSync && addedReadingMinutes <= 0) return;
  if (!view.linkedBookNote || !view.file) return;
  if (view.linkedBookNote.linkedEpubPath !== view.file.path) return;

  const noteFile = view.linkedBookNote.file;
  const pageNum = view.currentPageNum;
  const totalNum = view.totalPagesNum;
  const pctNum = view.currentProgressPct ?? view.approxProgressPct;
  const cfiToSync = view.stableCfi;
  const posTimeIso =
    view.lastLocalPositionSavedAt ||
    view.plugin.settings.progressUpdatedAt?.[view.file.path] ||
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
    console.error("MyEpubPlugin error syncing YAML frontmatter:", e);
  }
}