import { EpubCFI } from "epubjs";

/** A range must be collapsed by the CFI parser, never by deleting a comma. */
export function toNavigationCfi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!/^epubcfi\(.+\)$/.test(input)) return null;
  try {
    const components = input.slice(0, -1).split(",");
    // Versions <= 0.2.8 could persist a range with its end removed. Recreate
    // a zero-length range so the library can recover the original start.
    const legacyStart = components.length === 2 ? components[1] : undefined;
    if (components.length === 2 && (!legacyStart || !/^(\/|:)/.test(legacyStart))) return null;
    const candidate = legacyStart && /^(\/|:)/.test(legacyStart)
      ? `${input.slice(0, -1)},${legacyStart})` : input;
    if (components.length !== 1 && components.length !== 2 && components.length !== 3) return null;
    const parsed = new EpubCFI(candidate);
    if (!Number.isInteger(parsed.spinePos) || parsed.spinePos < 0 || !parsed.base.steps.length) {
      return null;
    }
    if (parsed.range) parsed.collapse(true);
    const result = parsed.toString();
    if (result.includes("NaN") || result.includes("undefined")) return null;
    return result;
  } catch {
    return null;
  }
}

export function withNavigationTimeout<T>(promise: PromiseLike<T>, ms = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Переход не завершился за 15 секунд")), ms);
    Promise.resolve(promise).then(
      value => { window.clearTimeout(timer); resolve(value); },
      (error: unknown) => { window.clearTimeout(timer); reject(error); }
    );
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function globalObsidianApp(): import("obsidian").App | undefined {
  return (window as Window & { app?: import("obsidian").App }).app;
}
