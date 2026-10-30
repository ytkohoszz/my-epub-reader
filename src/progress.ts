import { TFile } from "obsidian";
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

  const cleanCfi = toNavigationCfi(cfi) || cfi;
  if (view.book.locations && view.book.locations.length() > 0 && cleanCfi) {
    try {
      const p = view.book.locations.percentageFromCfi(cleanCfi);
      if (typeof p === "number" && Number.isFinite(p) && p >= 0) {
        return Math.max(0, Math.min(100, Math.round(p * 100)));
      }
    } catch {
      // Игнорируем
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
  if (!view.book) return null;
  const total = view.totalPagesNum || view.book.locations.length();
  if (!total || total <= 0) return null;

  const clampedPage = Math.max(1, Math.min(total, Math.round(page)));
  const idx = clampedPage - 1;
  const locs = view.book.locations as unknown as EpubLocationsExtended;

  // 1. Сначала берём из внутреннего массива _locations и обязательно сворачиваем диапазон через toNavigationCfi
  const fromArr = locs._locations?.[idx];
  const navFromArr = toNavigationCfi(fromArr);
  if (navFromArr) return navFromArr;

  // 2. Через метод cfiFromLocation
  if (typeof locs.cfiFromLocation === "function") {
    try {
      const cfi = locs.cfiFromLocation(idx);
      const navCfi = toNavigationCfi(cfi);
      if (navCfi) return navCfi;
    } catch {
      // Игнорируем
    }
  }

  // 3. Запасной вариант через процент
  try {
    const pct = total <= 1 ? 0 : idx / (total - 1);
    const rawPctCfi = view.book.locations.cfiFromPercentage(Math.max(0, Math.min(1, pct)));
    return toNavigationCfi(rawPctCfi);
  } catch {
    return null;
  }
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

  if (!localCfi) {
    return { cfi: yamlCfi, savedAt: yamlTimeStr || localTimeStr };
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

  // Если локальная позиция есть, всегда отдаём приоритет ей, чтобы старый YAML не сбрасывал чтение назад
  return { cfi: localCfi, savedAt: localTimeStr || yamlTimeStr };
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
    const curCfi = toNavigationCfi(cur?.start?.cfi);
    if (!view.navigationInFlight && curCfi) {
      if (cur) captureChapterMetricsFromLoc(view, cur);
      if (!view.stableCfi) view.stableCfi = curCfi;
      view.updateProgressLabels(view.stableCfi);
    }

    await reconcilePositionWithBookNote(view, file, currentLoadId);
    if (currentLoadId !== view.loadId || view.isClosing) return;

    view.finishInitialPositionRestore();
  } catch {
    if (currentLoadId === view.loadId && !view.isClosing) {
      view.isGeneratingLocations = false;
      view.finishInitialPositionRestore();
    }
  }
}

export async function reconcilePositionWithBookNote(
  view: EpubView,
  file: TFile,
  currentLoadId: number
) {
  if (view.ExplicitCfiJumpPending || view.userHasNavigated || view.isClosing) return;
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

  // Если пользователь вручную поменял поле «прочитано» в заметке книги (и оно отличается от страницы yamlCfi),
  // переходим на указанную страницу. Иначе берём точный CFI.
  const pickTargetCfiFromYaml = (): string | null => {
    if (yamlCfi) {
      if (yamlPage !== null) {
        const cfiIdx = Number(view.book!.locations.locationFromCfi(yamlCfi));
        if (Number.isFinite(cfiIdx) && cfiIdx >= 0) {
          const cfiPage = Math.max(1, Math.min(view.totalPagesNum!, cfiIdx + 1));
          if (Math.abs(cfiPage - yamlPage) >= 2) {
            return getCfiFromPageNumberSafe(view, yamlPage);
          }
        }
      }
      return yamlCfi;
    }
    if (yamlPage !== null) {
      return getCfiFromPageNumberSafe(view, yamlPage);
    }
    return null;
  };

  const applyRestoredCfi = async (targetCfi: string, timeIso: string) => {
    if (currentLoadId !== view.loadId || !view.rendition || view.userHasNavigated) return;
    view.stableCfi = targetCfi;
    view.lastLocalPositionSavedAt = timeIso;
    view.plugin.setLocalBookProgress(file.path, targetCfi, timeIso);
    try {
      await view.rendition.display(targetCfi);
    } catch {
      // Игнорируем
    }
    view.updateProgressLabels(targetCfi);
  };

  if (hasBothTimes) {
    if (localMs >= yamlMs) {
      // Локальная позиция в плагине свежее или равна YAML — ничего не откатываем!
      return;
    }
    const targetCfi = pickTargetCfiFromYaml();
    if (targetCfi && targetCfi !== view.stableCfi) {
      await applyRestoredCfi(targetCfi, yamlTimeStr!);
    }
    return;
  }

  // Если локальной позиции ещё вообще не было, восстанавливаем из YAML
  if (!view.stableCfi && (yamlCfi || yamlPage !== null)) {
    const targetCfi = pickTargetCfiFromYaml();
    if (targetCfi) {
      await applyRestoredCfi(targetCfi, yamlTimeStr || new Date().toISOString());
    }
    return;
  }

  // Если в YAML нет метки времени (например, изменили «прочитано» руками в дашборде) и нет yamlCfi
  if (!yamlCfi && yamlPage !== null && yamlPage !== localPage) {
    const targetCfi = getCfiFromPageNumberSafe(view, yamlPage);
    if (targetCfi) {
      await applyRestoredCfi(targetCfi, new Date().toISOString());
    }
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
  const file = view.activeBookFile ?? view.file;
  if (!view.linkedBookNote || !file) return;
  if (view.linkedBookNote.linkedEpubPath !== file.path) return;

  const cfiToSync = toNavigationCfi(view.stableCfi);
  if (!cfiToSync) return;

  // Перед записью в YAML обязательно пересчитываем актуальный номер страницы из stableCfi,
  // чтобы в заметке книги никогда не оставалась старая страница (например, 96).
  if (view.book && view.book.locations.length() > 0) {
    view.updateProgressLabels(cfiToSync);
  }

  const noteFile = view.linkedBookNote.file;
  const pageNum = view.currentPageNum;
  const totalNum = view.totalPagesNum;
  const pctNum = view.currentProgressPct ?? view.approxProgressPct;
  const posTimeIso =
    view.lastLocalPositionSavedAt ||
    view.plugin.settings.progressUpdatedAt?.[file.path] ||
    new Date().toISOString();

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
