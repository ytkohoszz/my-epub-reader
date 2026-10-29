import {
  cleanSelectedQuote,
  cleanSelectedWord,
  extractSentenceFromSelection,
} from "./modals";
import {
  EpubContentsExtended,
  EpubRenditionExtended,
  SELECTION_THROTTLE_MS,
} from "./settings";
import type { EpubView } from "./view";

export function bindActionButton(
  view: EpubView,
  btn: HTMLElement,
  handler: () => void
) {
  let lastTrigger = 0;
  const trigger = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTrigger < 350) return;
    lastTrigger = now;
    view.recordReadingActivity();
    syncSelectionFromAllIframes(view);
    handler();
  };
  btn.addEventListener("touchstart", trigger, { passive: false });
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", trigger);
}

export function syncSelectionFromAllIframes(view: EpubView, cfiOverride?: string) {
  try {
    const rendExt = view.rendition as unknown as EpubRenditionExtended | null;
    const contentsList = rendExt?.getContents?.() || [];
    for (const c of contentsList) {
      const win = c.window;
      const doc = c.document;
      const sel = win?.getSelection?.() || doc?.getSelection?.();
      const raw = sel?.toString() || "";
      if (raw.trim().length > 0) {
        saveCapturedText(view, raw, cfiOverride, c, sel);
        return;
      }
    }

    const iframes = view.boxEl ? Array.from(view.boxEl.querySelectorAll("iframe")) : [];
    for (const frame of iframes) {
      const doc = frame.contentDocument;
      const win = frame.contentWindow;
      const sel = win?.getSelection?.() || doc?.getSelection?.();
      const raw = sel?.toString() || "";
      if (raw.trim().length > 0) {
        saveCapturedText(view, raw, cfiOverride, undefined, sel);
        return;
      }
    }
  } catch {
    // Игнорируем
  }
}

export function saveCapturedText(
  view: EpubView,
  raw: string,
  cfiOverride?: string,
  contentsObj?: EpubContentsExtended,
  selObj?: Selection | null
) {
  const cleanedWord = cleanSelectedWord(raw);
  const cleanedQuote = cleanSelectedQuote(raw);
  if (!cleanedWord && !cleanedQuote) return;

  view.recordReadingActivity();
  view.capturedWord = cleanedWord;
  view.capturedQuote = cleanedQuote;
  view.lastSelectionAt = Date.now();

  const sentence = extractSentenceFromSelection(selObj, cleanedWord);
  if (sentence) {
    view.extractedSentence = sentence;
  }

  if (cfiOverride) {
    view.capturedCfi = cfiOverride;
  } else if (
    contentsObj &&
    selObj &&
    selObj.rangeCount > 0 &&
    typeof contentsObj.cfiFromRange === "function"
  ) {
    try {
      const range = selObj.getRangeAt(0);
      const computedCfi = contentsObj.cfiFromRange(range);
      if (computedCfi) view.capturedCfi = computedCfi;
    } catch {
      view.capturedCfi = view.stableCfi;
    }
  } else if (!view.capturedCfi) {
    view.capturedCfi = view.stableCfi;
  }

  view.updateSelectionButtonsState();
}

export function attachInternalLinkInterceptor(view: EpubView, doc: Document) {
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

      view.pushNavHistory();
    },
    { capture: true }
  );
}

export function getRelativeTapRatio(
  view: EpubView,
  target: Document | HTMLElement,
  clientX: number
): number {
  const wrapRect = view.wrapEl?.getBoundingClientRect();
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

export function attachTouchHandlers(
  view: EpubView,
  target: Document | HTMLElement,
  isInsideIframe: boolean,
  contentsObj?: EpubContentsExtended
) {
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
    return (
      win?.getSelection?.()?.toString() ||
      doc.getSelection?.()?.toString() ||
      ""
    ).trim();
  };

  const onTouchStart = (ev: Event) => {
    const e = ev as TouchEvent;
    const touch = e.changedTouches?.[0] ?? e.touches?.[0];
    if (!touch) return;
    view.recordReadingActivity();
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
        saveCapturedText(view, currentSel, undefined, contentsObj, sel);
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
      saveCapturedText(view, selAfter, undefined, contentsObj, sel);
      return;
    }

    if (hadSelectionOnStart || Date.now() - view.lastSelectionAt < 450) {
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
    if (now - view.lastGestureTime < 80) return;

    if (dt < 800 && Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      view.lastGestureTime = now;
      if (dx < 0) view.turnPage("next");
      else view.turnPage("prev");
      return;
    }

    if (
      e.type === "touchend" &&
      !isSwiping &&
      dt < 350 &&
      Math.abs(dx) < 15 &&
      Math.abs(dy) < 15
    ) {
      const el = e.target as HTMLElement | null;
      if (el?.closest && el.closest("a, button, .my-epub-fs-bar, .my-epub-back-pill")) {
        return;
      }

      view.lastGestureTime = now;
      const ratio = getRelativeTapRatio(view, target, endClientX);
      if (ratio < 0.26) {
        view.turnPage("prev");
      } else if (ratio > 0.74) {
        view.turnPage("next");
      } else {
        view.toggleFullscreen();
      }
    }
  };

  target.addEventListener("touchstart", onTouchStart, { passive: true });
  target.addEventListener("touchmove", onTouchMove, { passive: false });
  target.addEventListener("touchend", finishTouch, { passive: true });
  target.addEventListener("touchcancel", finishTouch, { passive: true });

  if (!isInsideIframe) {
    view.cleanupListeners.push(() => {
      target.removeEventListener("touchstart", onTouchStart);
      target.removeEventListener("touchmove", onTouchMove);
      target.removeEventListener("touchend", finishTouch);
      target.removeEventListener("touchcancel", finishTouch);
    });
  }
}

export function setupViewGesturesAndSelection(view: EpubView) {
  if (!view.rendition) return;

  view.rendition.on("selected", (cfiRange: string, contents: EpubContentsExtended) => {
    try {
      const sel =
        contents?.window?.getSelection?.() || contents?.document?.getSelection?.();
      const raw = sel?.toString() || "";
      if (raw.trim()) {
        saveCapturedText(view, raw, cfiRange, contents, sel);
      }
    } catch {
      // Игнорируем
    }
  });

  view.rendition.hooks.content.register((contents: EpubContentsExtended) => {
    const doc = contents?.document;
    const win = contents?.window;
    if (!doc) return;

    view.applyStyles();
    attachTouchHandlers(view, doc, true, contents);
    attachInternalLinkInterceptor(view, doc);

    const checkIframeSelection = () => {
      try {
        const sel = win?.getSelection?.() || doc.getSelection?.();
        const raw = sel?.toString() || "";
        if (raw.trim().length > 0) {
          saveCapturedText(view, raw, undefined, contents, sel);
        }
      } catch {
        // Игнорируем
      }
    };

    let lastSelCheckTime = 0;
    let selThrottleTimer: number | null = null;

    const onThrottledSelectionChange = () => {
      const now = Date.now();
      const elapsed = now - lastSelCheckTime;
      if (elapsed >= SELECTION_THROTTLE_MS) {
        if (selThrottleTimer !== null) {
          view.clearSelectionTimer(selThrottleTimer);
          selThrottleTimer = null;
        }
        lastSelCheckTime = now;
        checkIframeSelection();
      } else if (selThrottleTimer === null) {
        selThrottleTimer = view.scheduleSelectionTimer(() => {
          selThrottleTimer = null;
          lastSelCheckTime = Date.now();
          checkIframeSelection();
        }, SELECTION_THROTTLE_MS - elapsed);
      }
    };

    const onDocTouchEnd = () => {
      view.recordReadingActivity();
      view.scheduleSelectionTimer(checkIframeSelection, 30);
      view.scheduleSelectionTimer(checkIframeSelection, 180);
    };

    const onDocMouseUp = () => {
      view.recordReadingActivity();
      view.scheduleSelectionTimer(checkIframeSelection, 20);
    };

    doc.addEventListener("selectionchange", onThrottledSelectionChange);
    doc.addEventListener("touchend", onDocTouchEnd, { passive: true });
    doc.addEventListener("mouseup", onDocMouseUp);

    view.cleanupListeners.push(() => {
      if (selThrottleTimer !== null) {
        view.clearSelectionTimer(selThrottleTimer);
        selThrottleTimer = null;
      }
      doc.removeEventListener("selectionchange", onThrottledSelectionChange);
      doc.removeEventListener("touchend", onDocTouchEnd);
      doc.removeEventListener("mouseup", onDocMouseUp);
    });
  });

  if (view.wrapEl) {
    attachTouchHandlers(view, view.wrapEl, false);
  }

  view.rendition.on("keyup", (e: KeyboardEvent) => {
    view.recordReadingActivity();
    if (e.key === "ArrowRight") view.turnPage("next");
    else if (e.key === "ArrowLeft") view.turnPage("prev");
    else if (e.key === "Escape" && view.isFullscreen) view.toggleFullscreen(false);
  });
}