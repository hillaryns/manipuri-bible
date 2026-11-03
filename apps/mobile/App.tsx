import React, { useState } from "react";
import { SafeAreaView, StatusBar, View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { demoVerse, type BibleLanguage } from "@manipuri-bible/shared";
import "./supabase";

export default function App() {
  const [language, setLanguage] = useState<BibleLanguage>("manipuriRoman");
  const [playing, setPlaying] = useState(false);
  const verseText = language === "english" ? demoVerse.english : demoVerse.manipuriRoman;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.brand}>✦  THE WORD</Text>
        <View style={styles.header}>
          <View><Text style={styles.kicker}>SCRIPTURE, WITH YOU</Text><Text style={styles.title}>Good day.</Text></View>
          <Pressable style={styles.lang} onPress={() => setLanguage(language === "english" ? "manipuriRoman" : "english")}>
            <Text style={styles.langText}>{language === "english" ? "English" : "Manipuri"}</Text>
          </Pressable>
        </View>
        <View style={styles.hero}>
          <Text style={styles.kickerGold}>A MOMENT IN THE WORD</Text>
          <Text style={styles.heroTitle}>Read. Listen. Reflect.</Text>
          <Text style={styles.muted}>Explore Scripture in Manipuri and English, one verse at a time.</Text>
        </View>
        <Text style={styles.kicker}>CONTINUE READING</Text>
        <Text style={styles.chapter}>Genesis 1</Text>
        <View style={styles.card}>
          <Text style={styles.verseNo}>1</Text>
          <Text style={styles.verseLabel}>{language === "english" ? "ENGLISH" : "MANIPURI · ROMAN SCRIPT"}</Text>
          <Text style={styles.verse}>{verseText}</Text>
          <Pressable style={styles.play} onPress={() => setPlaying(!playing)}>
            <Text style={styles.playText}>{playing ? "Ⅱ  Pause audio" : "▶  Listen to verse"}</Text>
          </Pressable>
        </View>
        <Text style={styles.footer}>Made to make Scripture accessible to everyone.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#10100f" },
  container: { padding: 22, paddingTop: 28, flexGrow: 1 },
  brand: { color: "#e3c98d", letterSpacing: 3, fontWeight: "700", marginBottom: 42 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 30 },
  kicker: { color: "#9d978b", fontSize: 10, letterSpacing: 2, fontWeight: "700" },
  title: { color: "#eeeae1", fontSize: 34, marginTop: 7, fontWeight: "500" },
  lang: { borderWidth: 1, borderColor: "#454035", borderRadius: 9, padding: 10 },
  langText: { color: "#d8cba9" },
  hero: { padding: 24, borderWidth: 1, borderColor: "#4b402c", borderRadius: 15, backgroundColor: "#211e18", marginBottom: 36 },
  kickerGold: { color: "#c9ad70", fontSize: 10, letterSpacing: 2, fontWeight: "700" },
  heroTitle: { color: "#eee5d4", fontSize: 27, marginTop: 15, marginBottom: 8 },
  muted: { color: "#aaa397", lineHeight: 21 },
  chapter: { color: "#eeeae1", fontSize: 25, marginTop: 7, marginBottom: 15 },
  card: { padding: 20, borderWidth: 1, borderColor: "#34312a", borderRadius: 13, backgroundColor: "#171715" },
  verseNo: { color: "#d5bd86", backgroundColor: "#30291d", overflow: "hidden", borderRadius: 20, width: 30, height: 30, textAlign: "center", textAlignVertical: "center", marginBottom: 18 },
  verseLabel: { color: "#9c927e", fontSize: 9, letterSpacing: 1.5, fontWeight: "700" },
  verse: { color: "#e8e1d4", fontSize: 22, lineHeight: 33, marginTop: 12, marginBottom: 22 },
  play: { alignSelf: "flex-start", backgroundColor: "#c4a66b", borderRadius: 8, paddingVertical: 11, paddingHorizontal: 14 },
  playText: { color: "#17130b", fontWeight: "700" },
  footer: { color: "#706b61", fontSize: 11, marginTop: 48, textAlign: "center" }
});
