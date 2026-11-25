import { App, MarkdownView, Modal, Notice, TFile } from "obsidian";
import { globalObsidianApp } from "./navigation";
import { EpubRenditionExtended, getErrorMessage } from "./settings";
import { Rendition } from "epubjs";
import {
  BookNoteInfo,
  EXAMPLE_SEP,
  TranslationGroup,
  configureTranslationCache,
  extractLinkTarget,
  fetchTranslations,
  normStr,
  speakEnglishText,
} from "./modals";

export interface BookWordEntry {
  word: string;
  back: string;
  example: string;
  cfi: string | null;
  lineNumber: number;
}

export interface BookQuoteEntry {
  text: string;
  date: string;
  cfi: string | null;
  lineNumber: number;
}

export interface HighlightContextOptions {
  app: App;
  wordsFilePath: string;
  quotesFilePath: string;
  hostContainer?: HTMLElement | null;
}

const activePopoversByHost = new WeakMap<HTMLElement, () => void>();

const decodeInline = (s: string) =>
  String(s ?? "").replace(/⟩/g, ")").replace(/⟨/g, "(").trim();

function extractLinkCfi(raw: string): string | null {
  const str = decodeInline(String(raw ?? "")).trim();
  if (!str.startsWith("[[") || !str.endsWith("]]")) return null;
  const inner = str.slice(2, -2);
  const hashIdx = inner.indexOf("#");
  if (hashIdx === -1) return null;
  const barIdx = inner.indexOf("|");
  const endIdx = barIdx !== -1 && barIdx > hashIdx ? barIdx : inner.length;
  let anchor = inner.slice(hashIdx + 1, endIdx).trim();
  if (anchor.startsWith("cfi=")) anchor = anchor.slice(4).trim();
  return anchor.startsWith("epubcfi(") ? anchor : null;
}

function isSameBookTarget(targetStr: string | null, book: BookNoteInfo): boolean {
  if (!targetStr) return false;
  const clean = normStr(targetStr.replace(/\.md$/i, ""));
  return (
    clean === normStr(book.fileName) ||
    clean === normStr(book.title) ||
    normStr(targetStr) === normStr(book.path)
  );
}

function resolveVaultFile(app: App, rawPath: string): TFile | null {
  const clean = rawPath.trim();
  const direct = app.vault.getAbstractFileByPath(clean);
  if (direct instanceof TFile) return direct;
  const withMd = app.vault.getAbstractFileByPath(
    clean.endsWith(".md") ? clean : `${clean}.md`
  );
  if (withMd instanceof TFile) return withMd;
  const dest = app.metadataCache.getFirstLinkpathDest(clean, "");
  return dest instanceof TFile ? dest : null;
}

async function openVaultFileAtLine(app: App | null, rawPath: string, lineNumberOneBased: number) {
  const targetApp = app ?? (typeof window !== "undefined" ? globalObsidianApp() : null);
  if (!targetApp) return;

  const file = resolveVaultFile(targetApp, rawPath);
  if (!file) {
    new Notice(`Файл «${rawPath}» не найден.`);
    return;
  }

  const leaf = targetApp.workspace.getLeaf(false);
  await leaf.openFile(file);

  const lineIdx = Math.max(0, (lineNumberOneBased || 1) - 1);
  window.setTimeout(() => {
    try {
      const view = leaf.view;
      const editor = view instanceof MarkdownView ? view.editor : null;
      if (editor) {
        editor.setCursor({ line: lineIdx, ch: 0 });
        editor.scrollIntoView(
          { from: { line: lineIdx, ch: 0 }, to: { line: lineIdx, ch: 0 } },
          true
        );
        editor.focus();
      }
    } catch {
      // Игнорируем
    }
  }, 120);
}

export async function loadBookAnnotationsFromVault(
  app: App,
  linkedBook: BookNoteInfo | null,
  wordsFilePath: string,
  quotesFilePath: string
): Promise<{ words: BookWordEntry[]; quotes: BookQuoteEntry[] }> {
  const resolvedWordsPath = wordsFilePath || "Words Cards";
  const resolvedQuotesPath = quotesFilePath || "Знания/Цитаты из книг.md";
  configureTranslationCache(app);

  if (!linkedBook) return { words: [], quotes: [] };

  const words: BookWordEntry[] = [];
  const quotes: BookQuoteEntry[] = [];

  const wordsFile = resolveVaultFile(app, resolvedWordsPath);
  if (wordsFile) {
    try {
      const content = await app.vault.read(wordsFile);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const srIdx = line.indexOf("<!--SR:");
        const cardPart = srIdx === -1 ? line : line.slice(0, srIdx);
        if (!/:{2,3}/.test(cardPart) || cardPart.trimStart().startsWith("#")) continue;

        const parts = cardPart.split(/:{2,3}/);
        const rawFront = (parts[0] ?? "").replace(/^[-*+]\s+/, "").trim();
        const rawBackJoined = parts.slice(1).join(" ").trim();

        let cleanBack = rawBackJoined;
        let wiki: string | null = null;

        const inlineMatch = rawBackJoined.match(
          /^(.*?)\s*\((?:источник|книга)::\s*(\[\[[^\]]+\]\])\)\s*(?![\s\S])/i
        );
        if (inlineMatch && inlineMatch[1] !== undefined && inlineMatch[2] !== undefined) {
          cleanBack = inlineMatch[1].trim();
          wiki = inlineMatch[2].trim();
        } else {
          const dotMatch = rawBackJoined.match(
            /^(.*?)\s*(?:·|\|)\s*(\[\[[^\]]+\]\])\s*(?![\s\S])/
          );
          if (dotMatch && dotMatch[1] !== undefined && dotMatch[2] !== undefined) {
            cleanBack = dotMatch[1].trim();
            wiki = dotMatch[2].trim();
          }
        }

        if (!wiki) continue;
        const target = extractLinkTarget(wiki);
        if (!isSameBookTarget(target, linkedBook)) continue;

        const exIdx = rawFront.indexOf(EXAMPLE_SEP);
        const word = exIdx === -1 ? rawFront : rawFront.slice(0, exIdx).trim();
        const example = exIdx === -1 ? "" : rawFront.slice(exIdx + EXAMPLE_SEP.length).trim();

        words.push({
          word,
          back: cleanBack,
          example,
          cfi: extractLinkCfi(wiki),
          lineNumber: i + 1,
        });
      }
    } catch {
      // Игнорируем ошибку чтения
    }
  }

const quotesFile = resolveVaultFile(app, resolvedQuotesPath);
  if (quotesFile) {
    try {
      const content = await app.vault.read(quotesFile);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? "").trim();
        if (!line.startsWith("-") || !line.includes("цитата::")) continue;

        const fields: Record<string, string> = {};
        const fieldRegex = /\(([а-яА-Яa-zA-Z0-9_]+)::\s*([^)]+)\)/g;
        for (const match of line.matchAll(fieldRegex)) {
          const k = match[1]?.trim();
          const v = match[2]?.trim();
          if (k && v) fields[k] = v;
        }

        const quoteText = fields["цитата"] ? decodeInline(fields["цитата"]) : "";
        if (!quoteText) continue;

        const linkTarget =
          extractLinkTarget(fields["книга_ссылка"]) || extractLinkTarget(fields["книга"]);
        const rawBookTitle = decodeInline(fields["книга"] || "");

        if (
          !isSameBookTarget(linkTarget, linkedBook) &&
          normStr(rawBookTitle) !== normStr(linkedBook.title)
        ) {
          continue;
        }

        const cfi = fields["позиция"] ? decodeInline(fields["позиция"]).trim() : null;
        quotes.push({
          text: quoteText,
          date: decodeInline(fields["дата"] || ""),
          cfi: cfi && cfi.startsWith("epubcfi(") ? cfi : null,
          lineNumber: i + 1,
        });
      }
    } catch {
      // Игнорируем
    }
  }

  return { words: words.reverse(), quotes: quotes.reverse() };
}

function highlightStyles(
  fill: string,
  opacity: string,
  themeMode: "auto" | "sepia" | "night" = "auto"
): Record<string, string> {
  const isDark =
    themeMode === "night" ||
    (themeMode === "auto" && document.body.classList.contains("theme-dark"));
  return {
    fill,
    "fill-opacity": isDark ? "0.38" : opacity,
    "mix-blend-mode": isDark ? "normal" : "multiply",
  };
}

export function closeHighlightPopover(hostContainer?: HTMLElement | null) {
  const hostEl =
    hostContainer ||
    (document.querySelector(".view-content.my-epub") as HTMLElement | null) ||
    document.body;
  const fn = activePopoversByHost.get(hostEl);
  if (fn) {
    activePopoversByHost.delete(hostEl);
    try {
      fn();
    } catch {
      // Игнорируем
    }
  }
}

function showHighlightPopoverCard(
  rendition: Rendition,
  opts: {
    app: App;
    type: "word" | "quote";
    title: string;
    translationOrQuote: string;
    exampleOrDate: string;
    speakWord?: string;
    targetFilePath: string;
    lineNumber: number;
    hostContainer?: HTMLElement | null;
  }
) {
  const hostEl =
    opts.hostContainer ||
    (document.querySelector(".view-content.my-epub") as HTMLElement | null) ||
    document.body;

  closeHighlightPopover(hostEl);

  const cardEl = hostEl.createDiv({
    cls:
      "my-epub-hl-card " +
      (opts.type === "word" ? "my-epub-hl-card-word" : "my-epub-hl-card-quote"),
  });
  cardEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  cardEl.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  cardEl.addEventListener("click", (e) => e.stopPropagation());

  const head = cardEl.createDiv("my-epub-hl-card-head");
  head.createSpan({
    cls: "my-epub-hl-card-title",
    text: opts.type === "word" ? `🇬🇧 ${opts.title}` : `💬 ${opts.title}`,
  });

  const closeBtn = head.createEl("button", {
    cls: "my-epub-hl-card-close",
    text: "✕",
    attr: { type: "button", "aria-label": "Закрыть карточку" },
  });
closeBtn.onclick = () => closeHighlightPopover(hostEl);

  const mainBody = cardEl.createDiv("my-epub-hl-card-body");
  mainBody.setText(opts.translationOrQuote);

  if (opts.exampleOrDate) {
    cardEl.createDiv({
      cls: "my-epub-hl-card-example",
      text: opts.exampleOrDate,
    });
  }

  const actions = cardEl.createDiv("my-epub-hl-card-actions");

  if (opts.speakWord) {
    const wordToSpeak = opts.speakWord;
    const ttsBtn = actions.createEl("button", {
      cls: "my-epub-hl-card-btn",
      text: "🔊 Озвучить",
      attr: { type: "button", "aria-label": "Озвучить слово" },
    });
    ttsBtn.onclick = () => speakEnglishText(wordToSpeak);
  }

  const openLineBtn = actions.createEl("button", {
    cls: "mod-cta my-epub-hl-card-btn",
    text: `📄 Перейти в карточку (стр. ${opts.lineNumber})`,
    attr: { type: "button" },
  });
openLineBtn.onclick = () => {
    closeHighlightPopover(hostEl);
    void openVaultFileAtLine(opts.app, opts.targetFilePath, opts.lineNumber);
  };

  const cleanupTargets: Array<() => void> = [];
  const onOutsideTap = (ev: Event) => {
    const target = ev.target as Node | null;
    if (target && cardEl.contains(target)) return;
    closeHighlightPopover(hostEl);
  };

  const timerId = window.setTimeout(() => {
    document.addEventListener("pointerdown", onOutsideTap, true);
    document.addEventListener("touchstart", onOutsideTap, { capture: true, passive: true });
    cleanupTargets.push(() => {
      document.removeEventListener("pointerdown", onOutsideTap, true);
      document.removeEventListener("touchstart", onOutsideTap, true);
    });

    try {
      const contentsList = (rendition as unknown as EpubRenditionExtended).getContents?.() || [];
      for (const c of contentsList) {
        const doc: Document | undefined = c?.document;
        if (doc) {
          doc.addEventListener("pointerdown", onOutsideTap, true);
          doc.addEventListener("touchstart", onOutsideTap, { capture: true, passive: true });
          cleanupTargets.push(() => {
            doc.removeEventListener("pointerdown", onOutsideTap, true);
            doc.removeEventListener("touchstart", onOutsideTap, true);
          });
        }
      }
    } catch {
      // Игнорируем
    }
  }, 60);

const onRelocatedClose = () => closeHighlightPopover(hostEl);
  try {
    rendition.on("relocated", onRelocatedClose);
  } catch {
    // Игнорируем
  }

  activePopoversByHost.set(hostEl, () => {
    window.clearTimeout(timerId);
    for (const fn of cleanupTargets) {
      try {
        fn();
      } catch {
        // Игнорируем
      }
    }
    try {
      rendition.off?.("relocated", onRelocatedClose);
    } catch {
      // Игнорируем
    }
    cardEl.remove();
  });
}

export function applyHighlightsToRendition(
  rendition: Rendition | null,
  appliedCfis: Set<string>,
  words: BookWordEntry[],
  quotes: BookQuoteEntry[],
  themeMode: "auto" | "sepia" | "night" = "auto",
  ctx: HighlightContextOptions
) {
  closeHighlightPopover(ctx.hostContainer);
  if (!rendition || !rendition.annotations) return;

  for (const oldCfi of appliedCfis) {
    try {
      rendition.annotations.remove(oldCfi, "highlight");
    } catch {
      // Игнорируем
    }
  }
  appliedCfis.clear();

  const wordsPath = ctx.wordsFilePath || "Words Cards";
  const quotesPath = ctx.quotesFilePath || "Знания/Цитаты из книг.md";

  for (const w of words) {
    if (!w.cfi || !w.cfi.startsWith("epubcfi(") || !w.cfi.includes(",")) continue;
    try {
      rendition.annotations.highlight(
        w.cfi,
        {},
        () => {
          showHighlightPopoverCard(rendition, {
            app: ctx.app,
            type: "word",
            title: w.word,
            translationOrQuote: w.back,
            exampleOrDate: w.example ? `«${w.example}»` : "",
            speakWord: w.word,
            targetFilePath: wordsPath,
            lineNumber: w.lineNumber,
            hostContainer: ctx.hostContainer,
          });
        },
        "my-epub-hl-word",
        highlightStyles("#599ed6", "0.28", themeMode)
      );
      appliedCfis.add(w.cfi);
    } catch {
      // Игнорируем
    }
  }

  for (const q of quotes) {
    if (!q.cfi || !q.cfi.startsWith("epubcfi(") || !q.cfi.includes(",")) continue;
    try {
      rendition.annotations.highlight(
        q.cfi,
        {},
        () => {
          showHighlightPopoverCard(rendition, {
            app: ctx.app,
            type: "quote",
            title: "Цитата",
            translationOrQuote: `«${q.text}»`,
            exampleOrDate: q.date ? `Дата: ${q.date}` : "",
            targetFilePath: quotesPath,
            lineNumber: q.lineNumber,
            hostContainer: ctx.hostContainer,
          });
        },
        "my-epub-hl-quote",
        highlightStyles("#e5a158", "0.30", themeMode)
      );
      appliedCfis.add(q.cfi);
    } catch {
      // Игнорируем
    }
  }
}

// --- Быстрый перевод на лету без сохранения в словарь ---
export class QuickTranslateModal extends Modal {
  textToTranslate: string;
  autoSpeak: boolean;
  onSaveToVocab: (word: string) => void;

  constructor(
    app: App,
    textToTranslate: string,
    onSaveToVocab: (word: string) => void,
    autoSpeak = false
  ) {
    super(app);
    (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection = false;
    this.textToTranslate = textToTranslate;
    this.onSaveToVocab = onSaveToVocab;
    this.autoSpeak = autoSpeak;
    configureTranslationCache(app);
  }

  safeClose() {
    try {
      (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection = false;
      this.close();
    } catch {
      // Игнорируем
    }
  }

  async onOpen() {
    (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection = false;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("my-epub-modal");

    const head = contentEl.createDiv("my-epub-word-head");
    head.createSpan({ cls: "my-epub-word-title", text: "🌐 Быстрый перевод" });

    const topRow = contentEl.createDiv("my-epub-modal-row");
    const input = topRow.createEl("input", {
      cls: "my-epub-input-en",
      type: "text",
      value: this.textToTranslate,
      placeholder: "Слово или фраза на английском…",
    });

const speakBtn = topRow.createEl("button", {
      cls: "my-epub-modal-btn",
      text: "🔊",
      attr: { title: "Озвучить", "aria-label": "Озвучить" },
    });
    speakBtn.onclick = () => speakEnglishText(input.value);

    const trBtn = topRow.createEl("button", {
      cls: "my-epub-modal-btn",
      text: "Перевести",
    });

    const resultBox = contentEl.createDiv("my-epub-variants-box");
    resultBox.setText(
      this.textToTranslate.trim() ? "⏳ Перевожу…" : "Введи слово или фразу и нажми «Перевести»."
    );

    const footer = contentEl.createDiv("my-epub-modal-row-end");
    const toVocabBtn = footer.createEl("button", {
      cls: "mod-cta my-epub-modal-btn",
      text: "+ Открыть в форме словаря",
    });
    toVocabBtn.onclick = () => {
      const currentVal = input.value.trim() || this.textToTranslate;
      this.safeClose();
      this.onSaveToVocab(currentVal);
    };

    let requestSeq = 0;
    let closed = false;
    const origOnClose = this.onClose.bind(this);
    this.onClose = () => {
      closed = true;
      origOnClose();
    };

    const runLookup = async () => {
      const q = input.value.trim();
      if (!q) return;
      const mySeq = ++requestSeq;
      resultBox.empty();
      resultBox.setText("⏳ Перевожу…");
      try {
        const groups: TranslationGroup[] = await fetchTranslations(q);
        if (closed || mySeq !== requestSeq) return;
        resultBox.empty();
        if (!groups.length) {
          resultBox.setText("Перевод не найден.");
          return;
        }
        for (const g of groups) {
          const row = resultBox.createDiv("my-epub-variant-row");
          row.createSpan({ cls: "my-epub-variant-pos", text: g.pos });
          row.createSpan({
            cls: "my-epub-quick-terms",
            text: g.terms.join(" · "),
          });
        }
      } catch (e: unknown) {
        if (closed || mySeq !== requestSeq) return;
        resultBox.empty();
        resultBox.setText("Ошибка перевода: " + getErrorMessage(e));
      }
    };

    trBtn.onclick = () => void runLookup();
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void runLookup();
      }
    };

if (this.textToTranslate.trim()) {
      if (this.autoSpeak) speakEnglishText(this.textToTranslate);
      await runLookup();
    } else {
      window.setTimeout(() => input.focus(), 40);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}