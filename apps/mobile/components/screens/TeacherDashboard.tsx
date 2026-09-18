import React, { useCallback, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { teacherApi } from "../../lib/api";
import { useFocusEffect } from "@react-navigation/native";

// ──────────────────────────────────────────────
// Teacher home — real /teacher/dashboard: today's teaching schedule from
// timetable_slots, live enrolled counts (not capacity), today's marked
// attendance across the teacher's sections.
// ──────────────────────────────────────────────

type Dash = {
  totalClasses: number;
  totalStudents: number;
  attendanceToday: string | null;
  attendanceRate: number | null;
  schedule: Array<{ time: string; cls: string; sub: string; room: string }>;
  classOverview: Array<{ cls: string; students: number }>;
};

export default function TeacherDashboard({ onLogout }: { onLogout: () => void }) {
  const [dash, setDash] = useState<Dash | null>(null);
  const [name, setName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const d = await teacherApi.getDashboard();
      setDash({
        totalClasses: d.totalClasses ?? 0,
        totalStudents: d.totalStudents ?? 0,
        attendanceToday: d.attendanceToday ?? null,
        attendanceRate: d.attendanceRate ?? null,
        schedule: d.schedule ?? [],
        classOverview: d.classOverview ?? [],
      });
    } catch { /* keep previous / empty state */ }
    try {
      const p: any = await teacherApi.getProfile();
      setName([p?.firstName, p?.lastName].filter(Boolean).join(" ") || "Teacher");
    } catch { /* name stays generic */ }
    setLoading(false);
    setRefreshing(false);
  };

  useFocusEffect(
    useCallback(() => {
      load();
    }, []),
  );

  const today = new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  const next = dash?.schedule?.[0];

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <View className="flex-row justify-between items-center mb-6">
          <View>
            <Text className="text-on-surface-variant text-sm font-medium">{today}</Text>
            <Text className="text-2xl font-bold text-on-surface" numberOfLines={1}>Hello, {name || "Teacher"}</Text>
          </View>
          <TouchableOpacity onPress={onLogout} className="w-10 h-10 bg-primary/10 rounded-full justify-center items-center">
            <Text className="text-primary text-xs font-bold">OUT</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : next ? (
          <View className="bg-primary-container rounded-2xl p-5 shadow-sm">
            <Text className="text-white/80 text-sm mb-1">Next Class Today</Text>
            <Text className="text-2xl font-bold text-white mb-2">{next.cls}</Text>
            <View className="flex-row items-center justify-between">
              <Text className="text-white font-medium">{next.sub} · {next.time}</Text>
              <View className="bg-white/20 px-3 py-1 rounded-full">
                <Text className="text-white text-xs font-bold">{next.room}</Text>
              </View>
            </View>
          </View>
        ) : (
          <View className="bg-primary-container/70 rounded-2xl p-5">
            <Text className="text-white font-semibold">No classes scheduled today</Text>
            <Text className="text-white/70 text-sm mt-1">Enjoy the break — your periods show up here.</Text>
          </View>
        )}
      </View>

      <ScrollView
        className="flex-1 px-6 pt-6"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {/* Stat cards */}
        <View className="flex-row justify-between mb-6">
          <View className="bg-white flex-1 rounded-2xl p-4 mr-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">My Class-Sections</Text>
            <Text className="text-2xl font-bold text-primary">{dash?.totalClasses ?? 0}</Text>
          </View>
          <View className="bg-white flex-1 rounded-2xl p-4 mx-1 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">My Students</Text>
            <Text className="text-2xl font-bold text-on-surface">{dash?.totalStudents ?? 0}</Text>
          </View>
          <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Att. Today</Text>
            <Text className="text-2xl font-bold text-on-surface">{dash?.attendanceRate != null ? `${dash.attendanceRate}%` : "—"}</Text>
          </View>
        </View>

        {/* Today's schedule */}
        <View className="flex-row justify-between items-end mb-3">
          <Text className="text-lg font-bold text-on-surface">Today's Schedule</Text>
        </View>
        {(dash?.schedule?.length ?? 0) === 0 ? (
          <View className="bg-white rounded-2xl p-5 border border-surface-container-highest items-center mb-6">
            <Text className="text-3xl mb-2">🌤️</Text>
            <Text className="text-on-surface-variant text-sm text-center">Nothing scheduled for you today.</Text>
          </View>
        ) : (
          <View className="bg-white rounded-2xl p-2 shadow-sm border border-surface-container-highest mb-6">
            {dash!.schedule.map((s, index) => (
              <View key={`${s.time}-${s.cls}-${index}`} className={`flex-row items-center py-3 px-2 ${index !== dash!.schedule.length - 1 ? "border-b border-surface-container-low" : ""}`}>
                <Text className="w-24 text-on-surface-variant font-medium text-xs">{s.time}</Text>
                <View className="flex-1 ml-2">
                  <Text className="text-on-surface font-semibold" numberOfLines={1}>{s.cls}</Text>
                  <Text className="text-on-surface-variant text-xs mt-0.5">{s.sub}</Text>
                </View>
                <View className="bg-primary/10 px-2 py-1 rounded-md">
                  <Text className="text-primary text-xs font-bold">{s.room}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* My sections */}
        {(dash?.classOverview?.length ?? 0) > 0 && (
          <>
            <Text className="text-lg font-bold text-on-surface mb-3">My Sections</Text>
            <View className="flex-row flex-wrap mb-6">
              {dash!.classOverview.map((c) => (
                <View key={c.cls} className="bg-white rounded-2xl px-4 py-3 mr-2 mb-2 shadow-sm border border-surface-container-highest">
                  <Text className="text-on-surface font-semibold">{c.cls}</Text>
                  <Text className="text-on-surface-variant text-xs mt-0.5">{c.students} students</Text>
                </View>
              ))}
            </View>
          </>
        )}
        <View className="h-10" />
      </ScrollView>
    </View>
  );
}
