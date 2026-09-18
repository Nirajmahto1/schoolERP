import React, { useCallback, useState } from "react";
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { studentSelfApi } from "../../lib/api";

// ──────────────────────────────────────────────
// Student timetable — LIVE /students/my-timetable (Phase 9).
// Response: { className, timetable: [{ time, mon..fri }] } — the section's
// real grid, grouped by period time. Today's column is highlighted.
// ──────────────────────────────────────────────

type Row = { time: string; mon: string; tue: string; wed: string; thu: string; fri: string };
const DAYS = ["mon", "tue", "wed", "thu", "fri"] as const;
type Day = (typeof DAYS)[number];

export default function StudentTimetableScreen() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [className, setClassName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const res = await studentSelfApi.getMyTimetable();
      setClassName(res?.className ?? "");
      setRows(res?.timetable ?? []);
    } catch (e: any) {
      setError(e?.detail || "Could not load the timetable.");
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

  if (error || !rows) {
    return (
      <View className="flex-1 bg-surface justify-center items-center px-8">
        <Text className="text-on-surface-variant text-center mb-4">{error ?? "No timetable published yet."}</Text>
      </View>
    );
  }

  const today: Day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date().getDay()] as Day;
  const isSchoolDay = DAYS.includes(today);
  const dayName = (d: Day) => d.charAt(0).toUpperCase() + d.slice(1);

  // Today's periods, '-' filtered, for the day list below the week grid.
  const todayRows = isSchoolDay
    ? rows.map((r) => ({ time: r.time, subject: r[today] })).filter((r) => r.subject && r.subject !== "-")
    : [];

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-2">Timetable</Text>
        <Text className="text-on-surface-variant text-sm">{className || "Your class"}{isSchoolDay ? ` · ${dayName(today)} highlighted` : ""}</Text>
      </View>

      <ScrollView
        className="flex-1 px-6 pt-6"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(false); }} />}
      >
        {/* Week grid: rows = periods, columns = days */}
        <View className="bg-white rounded-2xl p-3 shadow-sm border border-surface-container-highest mb-6">
          <View className="flex-row mb-2">
            <View className="w-16" />
            {DAYS.map((d) => (
              <View key={d} className="flex-1 items-center">
                <Text className={`text-xs font-bold ${d === today ? "text-primary" : "text-on-surface-variant"}`}>{dayName(d)}</Text>
              </View>
            ))}
          </View>
          {rows.length === 0 && (
            <Text className="text-on-surface-variant text-center py-6">No periods scheduled.</Text>
          )}
          {rows.map((r, i) => (
            <View key={i} className={`flex-row py-2 ${i > 0 ? "border-t border-surface-container-low" : ""}`}>
              <View className="w-16 justify-center">
                <Text className="text-[10px] text-on-surface-variant font-medium">{r.time}</Text>
              </View>
              {DAYS.map((d) => {
                const subj = r[d];
                const active = d === today && subj && subj !== "-";
                return (
                  <View key={d} className="flex-1 px-0.5">
                    <View className={`rounded-lg py-2 px-0.5 ${active ? "bg-primary/10" : ""}`}>
                      <Text
                        className={`text-[10px] leading-tight ${active ? "text-primary font-bold" : "text-on-surface"}`}
                        numberOfLines={3}
                      >
                        {subj && subj !== "-" ? subj : "·"}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ))}
        </View>

        {/* Today, as a list */}
        {isSchoolDay && todayRows.length > 0 && (
          <View className="mb-10">
            <Text className="font-bold text-on-surface mb-3 text-lg">Today · {dayName(today)}</Text>
            {todayRows.map((r, i) => (
              <View key={i} className="rounded-2xl p-4 flex-row shadow-sm border border-surface-container-highest bg-white mb-3">
                <View className="w-20 border-r border-surface-container-highest mr-4 pr-2 justify-center">
                  <Text className="font-bold text-primary text-xs">{r.time}</Text>
                </View>
                <View className="flex-1 justify-center">
                  <Text className="text-on-surface font-bold text-base">{r.subject}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
