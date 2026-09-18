import React, { useCallback, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { teacherApi } from "../../lib/api";
import { useFocusEffect } from "@react-navigation/native";

// ──────────────────────────────────────────────
// My Timetable — real timetable_slots where this teacher takes the slot.
// Day chips (only days with teaching), ordered periods with subject,
// class-section, time and room. Today highlighted by default.
// ──────────────────────────────────────────────

type Slot = {
  id: string;
  startTime: string;
  endTime: string;
  subject: string;
  classSection: string;
  room: string | null;
};
type DayRow = { day: string; slots: Slot[] };

const DAY_LABEL: Record<string, string> = {
  MONDAY: "Mon", TUESDAY: "Tue", WEDNESDAY: "Wed",
  THURSDAY: "Thu", FRIDAY: "Fri", SATURDAY: "Sat", SUNDAY: "Sun",
};

export default function TeacherTimetableScreen() {
  const [days, setDays] = useState<DayRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      teacherApi
        .getMyTimetable()
        .then((res: any) => {
          const rows: DayRow[] = res?.days ?? [];
          setDays(rows);
          // Default to today when it has slots, else the first teaching day.
          const todayName = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"][new Date().getDay()];
          setSelected(rows.find((d) => d.day === todayName)?.day ?? rows[0]?.day ?? null);
          setError(null);
        })
        .catch((e: any) => setError(e?.detail || "Could not load your timetable."))
        .finally(() => setLoading(false));
    }, []),
  );

  const active = days.find((d) => d.day === selected) ?? null;

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-1">My Timetable</Text>
        <Text className="text-on-surface-variant text-sm">Your assigned periods this week</Text>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#004ac6" className="mt-10" />
      ) : error ? (
        <Text className="text-center mt-10 text-error px-8">{error}</Text>
      ) : days.length === 0 ? (
        <View className="items-center mt-16 px-8">
          <Text className="text-4xl mb-4">📅</Text>
          <Text className="text-on-surface-variant text-center">
            No timetable assigned yet. Once the school builds the timetable and assigns you periods, they appear here.
          </Text>
        </View>
      ) : (
        <>
          {/* Day chips */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="px-4 pt-4" contentContainerStyle={{ paddingRight: 16 }}>
            {days.map((d) => (
              <TouchableOpacity
                key={d.day}
                onPress={() => setSelected(d.day)}
                className={`px-4 py-2 rounded-full mr-2 ${selected === d.day ? "bg-primary" : "bg-surface-container-low border border-surface-container-highest"}`}
              >
                <Text className={`text-sm font-semibold ${selected === d.day ? "text-white" : "text-on-surface-variant"}`}>
                  {DAY_LABEL[d.day] ?? d.day}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <ScrollView className="flex-1 px-4 pt-4" showsVerticalScrollIndicator={false}>
            {active?.slots.map((s) => (
              <View key={s.id} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-3 flex-row">
                <View className="w-20 border-r border-surface-container-highest mr-4 pr-2 justify-center">
                  <Text className="text-primary font-bold text-sm">{s.startTime}</Text>
                  <Text className="text-on-surface-variant text-xs mt-0.5">{s.endTime}</Text>
                </View>
                <View className="flex-1">
                  <Text className="text-on-surface font-semibold text-base">{s.subject}</Text>
                  <Text className="text-on-surface-variant text-sm mt-0.5">{s.classSection}</Text>
                  {s.room ? <Text className="text-on-surface-variant text-xs mt-1">Room {s.room}</Text> : null}
                </View>
              </View>
            ))}
            <View className="h-10" />
          </ScrollView>
        </>
      )}
    </View>
  );
}
