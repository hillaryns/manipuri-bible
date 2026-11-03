import { getNkjvBookCode } from "./nkjv-book-codes.mjs";

export { getNkjvBookCode };

export type NkjvVerse = {
  id: string;
  verseNumber: number;
  text: string;
};

export type NkjvChapter = {
  content: string;
  copyright: string | null;
};

type NkjvApiResponse = {
  chapter?: {
    content?: unknown;
    copyright?: unknown;
  };
  error?: {
    message?: unknown;
  };
};

type CacheEntry = {
  value: NkjvChapter;
  expiresAt: number;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const chapterCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<NkjvChapter>>();

type VerseMarker = {
  element: Element;
  verseNumber: number;
  verseId: string | null;
  priority: number;
};

function verseNumberFromElement(element: Element): number | null {
  const usfm = element.getAttribute("data-usfm") ?? element.getAttribute("data-verse-id");
  if (usfm) {
    const usfmMatch = usfm.match(/(?:^|[.:])(\d+)(?:-\d+)?$/);
    if (usfmMatch) return Number(usfmMatch[1]);
  }

  for (const attribute of ["data-verse-number", "data-verse"]) {
    const value = element.getAttribute(attribute);
    if (value && /^\d+$/.test(value)) return Number(value);
  }

  const id = element.getAttribute("id");
  const idMatch = id?.match(/^v(\d+)(?:[-_.].*)?$/i);
  if (idMatch) return Number(idMatch[1]);

  if (element.classList.contains("v")) {
    const textMatch = element.textContent?.match(/^\s*(\d+)[a-z]?\s*$/i);
    if (textMatch) return Number(textMatch[1]);
  }

  return null;
}

function markerPriority(element: Element): number {
  if (element.hasAttribute("data-usfm")) return 5;
  if (element.hasAttribute("data-verse-number") || element.hasAttribute("data-verse")) return 4;
  if (element.hasAttribute("data-verse-id")) return 3;
  if (/^v\d+/i.test(element.id)) return 2;
  return 1;
}

function getVerseId(element: Element, chapterId: string, verseNumber: number): string | null {
  return (
    element.getAttribute("data-verse-id") ??
    element.getAttribute("data-usfm") ??
    element.id ??
    `${chapterId}.${verseNumber}`
  );
}

function cleanTextFragment(fragment: DocumentFragment | Element): string {
  fragment
    .querySelectorAll(
      "script, style, noscript, .f, .x, .footnote, .crossreference, .xref, .s1, .s2, .s3, .sr, .r, .d",
    )
    .forEach((element) => element.remove());
  fragment.querySelectorAll("br, p, div, li").forEach((element) => {
    const textNode = fragment.ownerDocument.createTextNode(` ${element.textContent ?? ""} `);
    element.replaceWith(textNode);
  });
  return (fragment.textContent ?? "").replace(/\s+/g, " ").trim();
}

function textAfterMarker(marker: VerseMarker, nextMarker: VerseMarker | undefined, body: HTMLElement): string {
  const markerText = marker.element.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const hasVerseText =
    markerText.length > 0 &&
    !new RegExp(`^${marker.verseNumber}[a-z]?$`, "i").test(markerText);

  if (hasVerseText) {
    const clone = marker.element.cloneNode(true) as Element;
    clone
      .querySelectorAll(
        ".v, [data-verse-number], [data-verse], [id^='v']",
      )
      .forEach((element) => {
        if (verseNumberFromElement(element) === marker.verseNumber) element.remove();
      });
    const text = cleanTextFragment(clone).replace(
      new RegExp(`^${marker.verseNumber}[a-z]?\\s+`, "i"),
      "",
    );
    if (text) return text;
  }

  const range = marker.element.ownerDocument.createRange();
  range.setStartAfter(marker.element);
  if (nextMarker) range.setEndBefore(nextMarker.element);
  else range.setEnd(body, body.childNodes.length);
  return cleanTextFragment(range.cloneContents());
}

export function parseNkjvChapterContent(content: string, chapterId: string): NkjvVerse[] {
  const parsed = new DOMParser().parseFromString(content, "text/html");
  const elements = parsed.body.querySelectorAll(
    "[data-usfm], [data-verse-id], [data-verse-number], [data-verse], [id^='v'], .v",
  );
  const markers: VerseMarker[] = [];

  elements.forEach((element) => {
    const verseNumber = verseNumberFromElement(element);
    if (verseNumber === null || !Number.isSafeInteger(verseNumber) || verseNumber < 1) return;
    markers.push({
      element,
      verseNumber,
      verseId: getVerseId(element, chapterId, verseNumber),
      priority: markerPriority(element),
    });
  });

  markers.sort((left, right) => {
    const priorityDifference = right.priority - left.priority;
    if (priorityDifference !== 0) return priorityDifference;
    const position = left.element.compareDocumentPosition(right.element);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  const selectedMarkers: VerseMarker[] = [];
  const seenVerses = new Set<number>();
  for (const marker of markers) {
    if (seenVerses.has(marker.verseNumber)) continue;
    seenVerses.add(marker.verseNumber);
    selectedMarkers.push(marker);
  }
  selectedMarkers.sort((left, right) => {
    const position = left.element.compareDocumentPosition(right.element);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return left.verseNumber - right.verseNumber;
  });

  return selectedMarkers.flatMap((marker, index) => {
    const text = textAfterMarker(marker, selectedMarkers[index + 1], parsed.body);
    return text
      ? [{
          id: marker.verseId ?? `${chapterId}.${marker.verseNumber}`,
          verseNumber: marker.verseNumber,
          text,
        }]
      : [];
  });
}

function pruneCache(now: number): void {
  for (const [key, entry] of chapterCache) {
    if (entry.expiresAt <= now) chapterCache.delete(key);
  }
  while (chapterCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = chapterCache.keys().next().value;
    if (oldestKey === undefined) break;
    chapterCache.delete(oldestKey);
  }
}

async function requestChapter(chapterId: string): Promise<NkjvChapter> {
  const response = await fetch(`/api/nkjv/chapters/${encodeURIComponent(chapterId)}`);
  let payload: NkjvApiResponse;
  try {
    payload = (await response.json()) as NkjvApiResponse;
  } catch {
    throw new Error("The NKJV service returned an invalid response.");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("NKJV access is not authorized. Check the API.Bible server configuration.");
    }
    if (response.status === 404) throw new Error("The selected NKJV chapter was not found.");
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new Error(
        `The NKJV service is busy. Please try again later${retryAfter ? ` (retry after ${retryAfter})` : ""}.`,
      );
    }
    const serverMessage =
      typeof payload.error?.message === "string" ? payload.error.message : null;
    throw new Error(serverMessage ?? `Unable to load NKJV content (HTTP ${response.status}).`);
  }

  if (typeof payload.chapter?.content !== "string") {
    throw new Error("The NKJV service returned chapter data in an unexpected format.");
  }

  const chapter: NkjvChapter = {
    content: payload.chapter.content,
    copyright:
      typeof payload.chapter.copyright === "string" && payload.chapter.copyright.trim()
        ? payload.chapter.copyright.trim()
        : null,
  };
  pruneCache(Date.now());
  chapterCache.set(chapterId, {
    value: chapter,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return chapter;
}

export function fetchNkjvChapter(chapterId: string): Promise<NkjvChapter> {
  const cached = chapterCache.get(chapterId);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (cached) chapterCache.delete(chapterId);

  const existingRequest = inFlightRequests.get(chapterId);
  if (existingRequest) return existingRequest;

  const request = requestChapter(chapterId).finally(() => {
    inFlightRequests.delete(chapterId);
  });
  inFlightRequests.set(chapterId, request);
  return request;
}
