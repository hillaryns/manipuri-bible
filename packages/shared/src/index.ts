export type Testament = "old" | "new";

export interface BibleBook {
  id: string;
  name: string;
  testament: Testament;
  order: number;
  chapterCount: number;
}

export interface BibleVerse {
  bookId: string;
  chapter: number;
  verse: number;
  manipuriRoman?: string;
  english?: string;
  audioPath?: string;
  audioStatus: "pending" | "uploaded" | "review";
}

export type BibleLanguage = "manipuriRoman" | "english";

export const demoVerse: BibleVerse = {
  bookId: "genesis",
  chapter: 1,
  verse: 1,
  manipuriRoman: "Manipuri verse text will appear here.",
  english: "In the beginning God created the heavens and the earth.",
  audioStatus: "pending"
};
