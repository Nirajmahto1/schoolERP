// ──────────────────────────────────────────────
// Live notification banner — a transient, tappable toast for frames arriving
// over the engine WebSocket. OS push (FCM) covers app-closed delivery; this
// covers app-open, where a system notification would be redundant.
// ──────────────────────────────────────────────

import React, { useEffect, useRef, useState } from "react";
import { Animated, Text, TouchableOpacity } from "react-native";
import type { LiveNotification } from "../lib/notify-ws";

const VISIBLE_MS = 5000;

export default function LiveNotificationBanner({
  notification,
  onTap,
}: {
  notification: LiveNotification | null;
  onTap?: (n: LiveNotification) => void;
}) {
  const slide = useRef(new Animated.Value(-120)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!notification) return;
    Animated.spring(slide, { toValue: 0, useNativeDriver: true }).start();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      Animated.timing(slide, { toValue: -120, duration: 250, useNativeDriver: true }).start();
    }, VISIBLE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [notification, slide]);

  if (!notification) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: 48,
        left: 12,
        right: 12,
        transform: [{ translateY: slide }],
        zIndex: 1000,
        elevation: 8,
      }}
    >
      <TouchableOpacity
        className="bg-surface-container-low rounded-2xl px-4 py-3 shadow-lg border border-surface-container-highest"
        activeOpacity={0.9}
        onPress={() => {
          Animated.timing(slide, { toValue: -120, duration: 150, useNativeDriver: true }).start();
          onTap?.(notification);
        }}
      >
        <Text className="text-on-surface font-bold text-sm" numberOfLines={1}>
          {notification.title}
        </Text>
        <Text className="text-on-surface-variant text-xs mt-0.5" numberOfLines={2}>
          {notification.body}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}
