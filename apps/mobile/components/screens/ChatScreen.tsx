import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, FlatList, KeyboardAvoidingView,
  Platform, ActivityIndicator, Alert,
} from "react-native";
import { chatApi, type ChatMessage as Msg } from "../../lib/api";
import { connectChatLive } from "../../lib/chat-ws";
import { useFocusEffect } from "@react-navigation/native";

// ──────────────────────────────────────────────
// Class-room chat (Phase 9) — the student's own section room.
//
// Server-derived membership: the student sees exactly their class+section;
// a guardian sees their child's room read-only; the send button hides when
// canPost is false. Delivery: WebSocket live push while the socket is up
// (lib/chat-ws), 5s polling as the fallback so a hub outage costs nothing —
// the outbox rule of the chat: the POST is the source of truth, the socket
// only makes it instant.
// ──────────────────────────────────────────────

const POLL_MS = 5000;

function timeLabel(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

export default function ChatScreen() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [canPost, setCanPost] = useState(true);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<Msg>>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveRef = useRef(false);
  const [live, setLive] = useState(false);
  const lastUserIdRef = useRef<string | null>(null);

  const load = async () => {
    try {
      const res = await chatApi.list();
      setMessages(res.data ?? []);
      setCanPost(res.canPost !== false);
      if (res.data?.length) lastUserIdRef.current = res.data[res.data.length - 1].authorId;
      setError(null);
    } catch (e: any) {
      setError(e?.detail || "Could not load the chat.");
    }
    setLoading(false);
  };

  useFocusEffect(
    useCallback(() => {
      load();
      // Polling stays on as the safety net, but at a relaxed cadence when
      // the socket is live — the poll is what heals a missed frame.
      pollRef.current = setInterval(() => { if (!liveRef.current) load(); }, POLL_MS);
      const disposeLive = connectChatLive({
        onMessage: (m) => {
          setMessages((prev) =>
            prev.some((x) => x.id === m.id)
              ? prev
              : [...prev, { ...m, mine: m.authorId === (lastUserIdRef.current ?? "") }],
          );
        },
        onLive: (v) => {
          liveRef.current = v;
          setLive(v);
          if (v) load(); // reconcile any frames missed while offline
        },
      });
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
        void disposeLive.then((d) => d());
      };
    }, []),
  );

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await chatApi.send(body);
      setDraft("");
      await load(); // pull the posted message into the transcript immediately
    } catch (e: any) {
      const msg = e?.detail || "Message could not be sent.";
      Alert.alert("Not sent", msg);
    }
    setSending(false);
  };

  if (loading) {
    return (
      <View className="flex-1 bg-surface justify-center items-center">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error && messages.length === 0) {
    return (
      <View className="flex-1 bg-surface justify-center items-center px-8">
        <Text className="text-on-surface-variant text-center mb-4">{error}</Text>
      </View>
    );
  }

  // Newest last; FlatList in inverted order for thumb-anchored scrolling.
  const data = [...messages].reverse();

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-4 px-6 bg-surface-container-low rounded-b-3xl">
        <View className="flex-row items-center justify-between">
          <Text className="text-2xl font-bold text-on-surface mb-1">Class Chat</Text>
          <View className={`flex-row items-center px-2 py-0.5 rounded-full ${live ? "bg-green-100" : "bg-surface-container-highest"}`}>
            <View className={`w-1.5 h-1.5 rounded-full mr-1 ${live ? "bg-green-600" : "bg-gray-400"}`} />
            <Text className={`text-[10px] ${live ? "text-green-700" : "text-on-surface-variant"}`}>
              {live ? "Live" : "Polling"}
            </Text>
          </View>
        </View>
        <Text className="text-on-surface-variant text-xs">
          Only your class & section can see this room.
        </Text>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1">
        <FlatList
          ref={listRef}
          data={data}
          inverted
          keyExtractor={(m) => m.id}
          className="flex-1 px-4"
          contentContainerStyle={{ paddingVertical: 12 }}
          renderItem={({ item }) => (
            <View className={`mb-2 max-w-[85%] ${item.mine ? "self-end items-end ml-auto" : "self-start items-start"}`}>
              {!item.mine && <Text className="text-[10px] text-on-surface-variant mb-0.5 ml-1">{item.authorName}</Text>}
              <View className={`rounded-2xl px-3 py-2 ${item.mine ? "bg-primary rounded-br-md" : "bg-surface-container-low rounded-bl-md border border-surface-container-highest"}`}>
                <Text className={`text-[15px] ${item.mine ? "text-white" : "text-on-surface"}`}>{item.body}</Text>
                <Text className={`text-[10px] mt-0.5 ${item.mine ? "text-white/70" : "text-on-surface-variant"}`}>
                  {timeLabel(item.createdAt)}
                </Text>
              </View>
            </View>
          )}
          ListEmptyComponent={
            <View className="py-10 items-center">
              <Text className="text-on-surface-variant text-sm">No messages yet — say hello 👋</Text>
            </View>
          }
        />

        {canPost ? (
          <View className="flex-row items-center px-4 py-3 border-t border-surface-container-highest bg-surface">
            <TextInput
              className="flex-1 bg-white border border-surface-container-highest rounded-full px-4 py-2.5 text-on-surface"
              placeholder="Message your class…"
              placeholderTextColor="#737686"
              value={draft}
              onChangeText={setDraft}
              multiline
              maxLength={1000}
            />
            <TouchableOpacity
              className="ml-2 w-11 h-11 rounded-full bg-primary justify-center items-center"
              onPress={send}
              disabled={sending || draft.trim().length === 0}
            >
              {sending
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text className="text-white text-lg font-bold">➤</Text>}
            </TouchableOpacity>
          </View>
        ) : (
          <View className="px-4 py-3 border-t border-surface-container-highest bg-surface">
            <Text className="text-on-surface-variant text-xs text-center">
              Read-only — you are viewing your child's class room.
            </Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}
