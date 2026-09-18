import React, { useCallback, useState } from "react";
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { studentSelfApi } from "../../lib/api";

// ──────────────────────────────────────────────
// Student attendance — LIVE /students/my-attendance (Phase 9).
// The endpoint returns the current month's day-by-day records plus a
// per-month summary; this renders both and nothing else.
// ──────────────────────────────────────────────

type AttendanceData = {
  currentMonth: Array<{ date: string; status: string }>;
  monthlySummary: Array<{ m: string; w: number; p: number; a: number; l: number; sortKey: string }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const sameDay = (iso: string, d: Date) => {
  const x = new Date(iso);
  return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate();
};

export default function StudentAttendanceScreen() {
  const [data, setData] = useState<AttendanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      setData(await studentSelfApi.getMyAttendance());
    } catch (e: any) {
      setError(e?.detail || "Could not load attendance.");
    }
    setLoading(false);
    setRefreshing(false);
  };

  useFocusEffect(useCallback(() => { load(true); }, []));

  if (loading) {
    return (
      <View className="flex-1 bg-surface justify-center items-center">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View className="flex-1 bg-surface justify-center items-center px-8">
        <Text className="text-on-surface-variant text-center mb-4">{error ?? "No attendance yet."}</Text>
      </View>
    );
  }

  const now = new Date();
  const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric" });

  // Day statuses for the calendar grid.
  const statusByDay = new Map<number, string>();
  for (const rec of data.currentMonth ?? []) {
    statusByDay.set(new Date(rec.date).getDate(), rec.status);
  }

  const present = (data.currentMonth ?? []).filter((r) => r.status === "present" || r.status === "half_day").length;
  const absent = (data.currentMonth ?? []).filter((r) => r.status === "absent" || r.status === "on_leave").length;
  const late = (data.currentMonth ?? []).filter((r) => r.status === "late").length;

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  const cellStyle = (day: number) => {
    const st = statusByDay.get(day);
    if (st === "absent" || st === "on_leave") return { bg: "bg-error/10", tx: "text-error" };
    if (st === "late") return { bg: "bg-amber-500/20", tx: "text-amber-600" };
    if (st === "present" || st === "half_day") return { bg: "bg-primary/10", tx: "text-primary" };
    const dow = new Date(now.getFullYear(), now.getMonth(), day).getDay();
    if (dow === 0 || dow === 6) return { bg: "bg-surface-container-highest", tx: "text-on-surface-variant" };
    return { bg: "bg-surface", tx: "text-outline-variant" };
  };

  // Monthly summary across the year (most recent first from the API).
  const totalW = (data.monthlySummary ?? []).reduce((s, m) => s + m.w, 0);
  const totalP = (data.monthlySummary ?? []).reduce((s, m) => s + m.p, 0);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-2">Attendance</Text>
        <Text className="text-on-surface-variant text-sm">{monthName}</Text>
      </View>

      <ScrollView
        className="flex-1 px-6 pt-6"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(false); }} />}
      >
        <View className="flex-row justify-between mb-6">
          <View className="bg-white flex-1 rounded-2xl p-4 mr-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Present</Text>
            <Text className="text-2xl font-bold text-green-600">{present} {present === 1 ? "Day" : "Days"}</Text>
          </View>
          <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Absent</Text>
            <Text className="text-2xl font-bold text-error">{absent} {absent === 1 ? "Day" : "Days"}</Text>
          </View>
          {late > 0 && (
            <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm border border-surface-container-highest">
              <Text className="text-on-surface-variant text-xs mb-1">Late</Text>
              <Text className="text-2xl font-bold text-amber-600">{late}</Text>
            </View>
          )}
        </View>

        <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-6">
          <Text className="font-bold text-on-surface mb-4 text-lg">This Month</Text>
          <View className="flex-row flex-wrap justify-between">
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const { bg, tx } = cellStyle(day);
              const isToday = sameDay(new Date().toISOString(), new Date(now.getFullYear(), now.getMonth(), day));
              return (
                <View key={i} className={`w-[13%] aspect-square justify-center items-center rounded-full mb-2 ${bg}`}>
                  <Text className={`font-medium ${tx}`}>{day}</Text>
                </View>
              );
            })}
          </View>

          <View className="flex-row justify-between mt-4 border-t border-surface-container-low pt-4">
            <View className="flex-row items-center"><View className="w-3 h-3 rounded-full bg-primary/20 mr-2"></View><Text className="text-xs text-on-surface-variant">Present</Text></View>
            <View className="flex-row items-center"><View className="w-3 h-3 rounded-full bg-error/20 mr-2"></View><Text className="text-xs text-on-surface-variant">Absent</Text></View>
            <View className="flex-row items-center"><View className="w-3 h-3 rounded-full bg-amber-500/20 mr-2"></View><Text className="text-xs text-on-surface-variant">Late</Text></View>
          </View>
        </View>

        {(data.monthlySummary?.length ?? 0) > 0 && (
          <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-10">
            <Text className="font-bold text-on-surface mb-3 text-lg">Year Overview</Text>
            {data.monthlySummary.map((m) => (
              <View key={m.sortKey} className="flex-row justify-between py-2 border-b border-surface-container-low last:border-b-0">
                <Text className="text-on-surface font-medium">{m.m}</Text>
                <Text className="text-on-surface-variant">
                  {m.p}/{m.w} present{m.a > 0 ? ` · ${m.a} absent` : ""}{m.l > 0 ? ` · ${m.l} late` : ""}
                </Text>
              </View>
            ))}
            <View className="flex-row justify-between py-3 mt-2 border-t border-surface-container-highest">
              <Text className="text-on-surface font-bold">Total</Text>
              <Text className="text-primary font-bold">
                {totalW > 0 ? Math.round((totalP / totalW) * 100) : 0}% overall
              </Text>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
