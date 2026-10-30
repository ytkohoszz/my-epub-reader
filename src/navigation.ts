import { EpubCFI } from "epubjs";

/**
 * Преобразует любой CFI (точечный, диапазонный из locations._locations с 2 запятыми
 * или повреждённый с 1 запятой от старых версий) в валидный точечный CFI для rendition.display().
 */
export function toNavigationCfi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input.startsWith("epubcfi(") || !input.endsWith(")")) return null;

  const inner = input.slice(8, -1).trim();
  if (!inner) return null;

  const parts = inner.split(",");
  let pointCfi = input;

  if (parts.length >= 2) {
    const base = (parts[0] ?? "").trim();
    const start = (parts[1] ?? "").trim();
    if (!base) return null;
    if (start && (start.startsWith("/") || start.startsWith(":") || start.startsWith("!"))) {
      pointCfi = `epubcfi(${base}${start})`;
    } else {
      pointCfi = `epubcfi(${base})`;
    }
  }

  try {
    const parsed = new EpubCFI(pointCfi);
    if (!Number.isInteger(parsed.spinePos) || parsed.spinePos < 0) {
      return pointCfi;
    }
    if (parsed.range) parsed.collapse(true);
    const str = parsed.toString();
    if (str.startsWith("epubcfi(") && !str.includes("NaN") && !str.includes("undefined")) {
      return str;
    }
  } catch {
    // Если конструктор EpubCFI не распарсил нестандартный шаг, возвращаем склеенный pointCfi
  }

  return pointCfi;
}

export function withNavigationTimeout<T>(promise: PromiseLike<T>, ms = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Переход не завершился за 15 секунд")),
      ms
    );
    Promise.resolve(promise).then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function globalObsidianApp(): import("obsidian").App | undefined {
  return (window as Window & { app?: import("obsidian").App }).app;
}
