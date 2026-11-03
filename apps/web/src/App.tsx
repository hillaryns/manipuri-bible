import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Headphones,
  Bookmark,
  Search,
  Play,
  Pause,
  Languages,
  Menu,
} from "lucide-react";
import type { BibleLanguage } from "@manipuri-bible/shared";
import { supabase } from "./supabase";
import {
  fetchNkjvChapter,
  getNkjvBookCode,
  parseNkjvChapterContent,
} from "./nkjv";
import { getBookDisplayName } from "./book-display-names.mjs";

type BookRow = {
  id: number;
  name: string;
  book_order: number;
  chapter_count: number;
};

type ChapterRow = {
  id: number;
  book_id: number;
  chapter_number: number;
};

type VerseRow = {
  id: number;
  chapter_id: number;
  verse_number: number;
};

type TranslationRow = {
  verse_id: number;
  language: string;
  text: string;
  audio_path: string | null;
};

type ReaderVerse = {
  id: string;
  verseNumber: number;
  text: string;
  audioPath: string | null;
};

const LANGUAGE_CODES: Record<BibleLanguage, string> = {
  manipuriRoman: "manipuri_roman",
  english: "english",
};

export default function App() {
  const [language, setLanguage] = useState<BibleLanguage>("manipuriRoman");
  const [playingVerseId, setPlayingVerseId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [books, setBooks] = useState<BookRow[]>([]);
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  const [verses, setVerses] = useState<ReaderVerse[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<number | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<number | null>(null);
  const [booksLoading, setBooksLoading] = useState(true);
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [versesLoading, setVersesLoading] = useState(false);
  const [booksRetryCount, setBooksRetryCount] = useState(0);
  const [chaptersRetryCount, setChaptersRetryCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [nkjvCopyright, setNkjvCopyright] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const selectedBook = books.find((book) => book.id === selectedBookId) ?? null;
  const selectedChapter = chapters.find((chapter) => chapter.id === selectedChapterId) ?? null;
  const selectedBookDisplayName = selectedBook
    ? getBookDisplayName(selectedBook.name, language)
    : null;
  const translationLanguage = LANGUAGE_CODES[language];
  const verseLabel =
    language === "english" ? "NEW KING JAMES VERSION® (NKJV)" : "MANIPURI · ROMAN SCRIPT";
  const reference = useMemo(
    () =>
      selectedBook && selectedChapter
        ? `${getBookDisplayName(selectedBook.name, language).toUpperCase()} · CHAPTER ${selectedChapter.chapter_number}`
        : "SELECT A BOOK AND CHAPTER",
    [selectedBook, selectedChapter, language],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadBooks() {
      if (!supabase) {
        setBooksLoading(false);
        setError("Supabase is not configured. Set the VITE_SUPABASE_URL and publishable key to load the Bible.");
        return;
      }

      setBooksLoading(true);
      setError(null);
      const { data, error: queryError } = await supabase
        .from("books")
        .select("id, name, book_order, chapter_count")
        .order("book_order", { ascending: true });

      if (cancelled) return;
      if (queryError) {
        setError(`Unable to load Bible books: ${queryError.message}`);
        setBooks([]);
      } else {
        const rows = (data ?? []) as BookRow[];
        setBooks(rows);
        setSelectedBookId(rows[0]?.id ?? null);
        setLoaded(true);
        if (rows.length === 0) setError("No Bible books are available yet.");
      }
      setBooksLoading(false);
    }

    void loadBooks();
    return () => {
      cancelled = true;
    };
  }, [booksRetryCount]);

  useEffect(() => {
    let cancelled = false;
    const client = supabase;
    setChapters([]);
    setSelectedChapterId(null);
    setVerses([]);

    if (!client || selectedBookId === null) {
      setChaptersLoading(false);
      return () => {
        cancelled = true;
      };
    }

    async function loadChapters(database: NonNullable<typeof supabase>) {
      setChaptersLoading(true);
      setError(null);
      const { data, error: queryError } = await database
        .from("chapters")
        .select("id, book_id, chapter_number")
        .eq("book_id", selectedBookId)
        .order("chapter_number", { ascending: true });

      if (cancelled) return;
      if (queryError) {
        setError(`Unable to load chapters: ${queryError.message}`);
        setChapters([]);
      } else {
        const rows = (data ?? []) as ChapterRow[];
        setChapters(rows);
        setSelectedChapterId(rows[0]?.id ?? null);
        if (rows.length === 0) setError("This book has no available chapters.");
      }
      setChaptersLoading(false);
    }

    void loadChapters(client);
    return () => {
      cancelled = true;
    };
  }, [selectedBookId, selectedBook?.name, chaptersRetryCount]);

  useEffect(() => {
    let cancelled = false;
    const client = supabase;
    setVerses([]);
    setError(null);
    setEmptyMessage(null);
    setNkjvCopyright(null);

    if (selectedChapterId === null || (language !== "english" && !client)) {
      setVersesLoading(false);
      return () => {
        cancelled = true;
      };
    }

    async function loadVerses(database: NonNullable<typeof supabase> | null) {
      setVersesLoading(true);
      setError(null);
      if (language === "english") {
        const bookCode = selectedBook ? getNkjvBookCode(selectedBook.name) : null;
        if (!bookCode || !selectedChapter) {
          setError(
            selectedBook
              ? `NKJV book mapping is not available for ${getBookDisplayName(selectedBook.name, language)}.`
              : "Select a book and chapter to load NKJV.",
          );
          setVersesLoading(false);
          return;
        }

        const chapterId = `${bookCode}.${selectedChapter.chapter_number}`;
        try {
          const chapter = await fetchNkjvChapter(chapterId);
          if (cancelled) return;
          const parsedVerses = parseNkjvChapterContent(chapter.content, chapterId);
          setNkjvCopyright(chapter.copyright);
          setVerses(
            parsedVerses.map((verse) => ({
              ...verse,
              audioPath: null,
            })),
          );
          if (parsedVerses.length === 0) {
            setEmptyMessage("No NKJV verses were found in the returned chapter.");
          }
        } catch (loadError) {
          if (cancelled) return;
          setVerses([]);
          setError(
            loadError instanceof Error ? loadError.message : "Unable to load the NKJV chapter.",
          );
        } finally {
          if (!cancelled) setVersesLoading(false);
        }
        return;
      }

      if (!database) {
        setError("Supabase is not configured. Set the VITE_SUPABASE_URL and publishable key to load the Bible.");
        setVersesLoading(false);
        return;
      }

      const { data: verseData, error: verseError } = await database
        .from("verses")
        .select("id, chapter_id, verse_number")
        .eq("chapter_id", selectedChapterId)
        .order("verse_number", { ascending: true });

      if (cancelled) return;
      if (verseError) {
        setError(`Unable to load verses: ${verseError.message}`);
        setVersesLoading(false);
        return;
      }

      const verseRows = (verseData ?? []) as VerseRow[];
      if (verseRows.length === 0) {
        setVerses([]);
        setEmptyMessage("No verses are available for this chapter yet.");
        setVersesLoading(false);
        return;
      }

      const { data: translationData, error: translationError } = await database
        .from("verse_translations")
        .select("verse_id, language, text, audio_path")
        .in(
          "verse_id",
          verseRows.map((verse) => verse.id),
        )
        .eq("language", translationLanguage);

      if (cancelled) return;
      if (translationError) {
        setError(`Unable to load verse translations: ${translationError.message}`);
        setVerses([]);
      } else {
        const translations = (translationData ?? []) as TranslationRow[];
        const textByVerseId = new Map(
          translations.map((translation) => [translation.verse_id, translation]),
        );
        const readerVerses = verseRows.flatMap((verse) => {
          const translation = textByVerseId.get(verse.id);
          return translation === undefined
            ? []
            : [{
                id: String(verse.id),
                verseNumber: verse.verse_number,
                text: translation.text,
                audioPath: translation.audio_path,
              }];
        });
        setVerses(readerVerses);
        if (readerVerses.length === 0) {
          setEmptyMessage("No Manipuri Roman translations are available for this chapter.");
        }
      }
      setVersesLoading(false);
    }

    void loadVerses(client);
    return () => {
      cancelled = true;
    };
  }, [
    selectedBook?.name,
    selectedChapter?.chapter_number,
    selectedChapterId,
    translationLanguage,
    language,
    retryCount,
  ]);

  function selectBook(bookId: number) {
    setSelectedBookId(bookId);
    audioRef.current?.pause();
    setPlayingVerseId(null);
  }

  function selectChapter(chapterId: number) {
    setSelectedChapterId(chapterId);
    audioRef.current?.pause();
    setPlayingVerseId(null);
  }

  function toggleLanguage() {
    setLanguage((current) => (current === "english" ? "manipuriRoman" : "english"));
    audioRef.current?.pause();
    setPlayingVerseId(null);
    setVerses([]);
  }

  function retryCurrentLoad() {
    if (selectedBookId === null) {
      setBooksRetryCount((count) => count + 1);
    } else if (selectedChapterId === null || chapters.length === 0) {
      setChaptersRetryCount((count) => count + 1);
    } else {
      setRetryCount((count) => count + 1);
    }
  }

  async function toggleAudio(verse: ReaderVerse) {
    const audio = audioRef.current;
    if (!audio || !verse.audioPath) return;
    if (playingVerseId === verse.id && !audio.paused) {
      audio.pause();
      setPlayingVerseId(null);
      return;
    }

    audio.src = verse.audioPath;
    try {
      await audio.play();
      setPlayingVerseId(verse.id);
      setError(null);
    } catch (playError) {
      setError(
        `Unable to play this verse: ${playError instanceof Error ? playError.message : "audio playback failed."}`,
      );
      setPlayingVerseId(null);
    }
  }

  const loadingMessage = booksLoading
    ? "Loading books…"
    : chaptersLoading
      ? "Loading chapters…"
      : versesLoading
        ? language === "english"
          ? "Loading NKJV chapter…"
          : "Loading verses…"
        : null;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <BookOpen size={23} />
          <span>THE WORD</span>
        </div>
        <p className="eyebrow">YOUR BIBLE</p>
        <button className="nav active" type="button">
          <BookOpen size={18} /> Read Bible
        </button>
        <button className="nav" type="button" disabled>
          <Headphones size={18} /> Listen
        </button>
        <button className="nav" type="button" disabled>
          <Bookmark size={18} /> Bookmarks
        </button>
        <div className="sidebar-note">
          Manipuri · English (NKJV)
          <br />
          A Bible for everyone.
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <button className="icon-button mobile-menu" type="button" aria-label="Menu" disabled>
            <Menu />
          </button>
          <div>
            <span className="eyebrow">SCRIPTURE, WITH YOU</span>
            <h1>Good day.</h1>
          </div>
          <button
            className="language-button"
            type="button"
            onClick={toggleLanguage}
            aria-label={`Switch to ${language === "english" ? "Manipuri (Roman Script)" : "English (NKJV)"}`}
          >
            <Languages size={17} />
            {language === "english" ? "English (NKJV)" : "Manipuri (Roman)"}
          </button>
        </header>

        <div className="welcome-card">
          <span className="eyebrow gold">A MOMENT IN THE WORD</span>
          <h2>Read. Listen. Reflect.</h2>
          <p>Explore Scripture in Manipuri Roman Script and English (NKJV), one verse at a time.</p>
          <div className="reference">{reference}</div>
          <div className="reader-navigation">
            <label>
              <span className="eyebrow">BOOK</span>
              <select
                aria-label="Select book"
                value={selectedBookId ?? ""}
                onChange={(event) => selectBook(Number(event.target.value))}
                disabled={booksLoading || books.length === 0}
              >
                {books.length === 0 && <option value="">No books available</option>}
                {books.map((book) => (
                  <option key={book.id} value={book.id}>
                    {getBookDisplayName(book.name, language)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="eyebrow">CHAPTER</span>
              <select
                aria-label="Select chapter"
                value={selectedChapterId ?? ""}
                onChange={(event) => selectChapter(Number(event.target.value))}
                disabled={chaptersLoading || chapters.length === 0}
              >
                {chapters.length === 0 && <option value="">No chapters available</option>}
                {chapters.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>
                    {chapter.chapter_number}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="section-heading">
          <div>
            <span className="eyebrow">CONTINUE READING</span>
            <h2>{selectedBookDisplayName && selectedChapter ? `${selectedBookDisplayName} ${selectedChapter.chapter_number}` : "Bible reader"}</h2>
          </div>
          <button className="search-button" type="button" disabled>
            <Search size={17} /> Find a verse
          </button>
        </div>

        {loadingMessage && <p className="reader-message">{loadingMessage}</p>}
        {error && !loadingMessage && (
          <div className="reader-message error-message reader-state" role="alert">
            <span>{error}</span>
            <button type="button" onClick={retryCurrentLoad}>Retry</button>
          </div>
        )}
        {emptyMessage && !loadingMessage && !error && (
          <div className="reader-message reader-state" role="status">
            <span>{emptyMessage}</span>
            <button type="button" onClick={retryCurrentLoad}>Try again</button>
          </div>
        )}
        {!loadingMessage &&
          verses.map((verse) => (
            <article className="verse-card" key={verse.id}>
              <div className="verse-number">{verse.verseNumber}</div>
              <div className="verse-body">
                <div className="verse-label">{verseLabel}</div>
                <p className="verse-text">{verse.text}</p>
                <div className="verse-actions">
                  <button
                    className="play-button"
                    type="button"
                    onClick={() => void toggleAudio(verse)}
                    disabled={!verse.audioPath}
                    aria-label={verse.audioPath ? `${playingVerseId === verse.id ? "Pause" : "Play"} verse ${verse.verseNumber}` : "Audio unavailable"}
                  >
                    <span className="play-icon">
                      {playingVerseId === verse.id ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}
                    </span>
                    {!verse.audioPath
                      ? "Audio unavailable"
                      : playingVerseId === verse.id
                        ? "Pause audio"
                        : "Listen to verse"}
                  </button>
                  <button className="text-action" type="button" disabled>
                    <Bookmark size={16} /> Save
                  </button>
                </div>
              </div>
            </article>
          ))}

        {language === "english" && verses.length > 0 && (
          <p className="scripture-attribution">
            {nkjvCopyright ??
              "New King James Version® (NKJV®). Copyright © 1982 by Thomas Nelson. Used by permission. All rights reserved."}{" "}
            Scripture text provided through{" "}
            <a href="https://www.api.bible/" target="_blank" rel="noreferrer">
              API.Bible
            </a>
            .
          </p>
        )}

        <audio
          ref={audioRef}
          onEnded={() => setPlayingVerseId(null)}
          onError={() => {
            setPlayingVerseId(null);
            setError("Unable to load audio for this verse.");
          }}
        />
        <div className="setup-hint" role="status">
          <span className={`status-dot ${loaded ? "connected" : ""}`}></span>
          {loaded ? "Supabase connected" : "Connecting to Supabase"}
        </div>
        <footer>Made to make Scripture accessible to everyone.</footer>
      </section>
    </main>
  );
}
