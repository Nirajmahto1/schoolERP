import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { parentApi } from "../../lib/api";

// ──────────────────────────────────────────────
// Parent dashboard — LIVE children-summary (Phase 9).
//
// One endpoint, built for this screen: children with class/section, recent
// published results, book issues, plus aggregate stats (attendance % over
// monthly summaries, outstanding fees across ALL children). Multi-child
// families get a switcher — §9.1 "multi-child switcher" is the plan's first
// parent-app requirement.
// ──────────────────────────────────────────────
interface Child {
  id: string;
  firstName: string;
  lastName: string;
  admissionNo: string;
  className: string | null;
  sectionName: string | null;
  recentResults: Array<{ examSubject: { subject: { name: string } }; marksObtained: unknown; isAbsent: boolean }>;
  bookIssues: unknown[];
}

interface Summary {
  students: Child[];
  stats: { attendancePct: number; pendingFees: number; booksIssued: number };
}

export default function ParentDashboard({ navigation }: any) {
  const [data, setData] = useState<Summary | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const res = await parentApi.getMeChildrenSummary();
      setData(res);
      setSelected((s) => Math.min(s, (res.students?.length ?? 1) - 1));
    } catch (e: any) {
      setError(e?.detail || 'Could not load your children.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(false);
    setRefreshing(false);
  }, [load]);

  const child = data?.students?.[selected];

  // Percentage on the most recent published exam entries (server caps 20).
  const recentGrades = (child?.recentResults ?? [])
    .slice(0, 4)
    .map((r) => {
      const max = Number((r as any).examSubject?.maxMarks ?? 100);
      const got = Number(r.marksObtained ?? 0);
      return { subject: r.examSubject?.subject?.name ?? '—', pct: r.isAbsent ? null : Math.round((got / Math.max(1, max)) * 100) };
    });

  const fmtINR = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        {data && data.students.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4">
            {data.students.map((s, i) => (
              <TouchableOpacity key={s.id} onPress={() => setSelected(i)}
                className={`mr-2 px-4 py-2 rounded-full border ${i === selected ? 'bg-primary border-primary' : 'bg-white border-surface-container-highest'}`}>
                <Text className={`font-semibold text-sm ${i === selected ? 'text-white' : 'text-on-surface'}`}>
                  {s.firstName} {s.lastName}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        <View className="flex-row justify-between items-center mb-6">
          <View>
            <Text className="text-on-surface-variant text-sm font-medium">Child Profile</Text>
            <Text className="text-2xl font-bold text-on-surface">
              {child ? `${child.firstName} ${child.lastName}` : '—'}
            </Text>
            <Text className="text-on-surface-variant text-xs">
              {child ? `${child.className ?? '—'} ${child.sectionName ? `- Section ${child.sectionName}` : ''} • ${child.admissionNo}` : ''}
            </Text>
          </View>
        </View>

        <View className="bg-primary-container rounded-2xl p-5 shadow-sm flex-row">
          <View className="flex-1">
            <Text className="text-white/80 text-sm mb-1">Attendance</Text>
            <Text className="text-3xl font-bold text-white">{data?.stats.attendancePct ?? 0}%</Text>
          </View>
          <View className="flex-1">
            <Text className="text-white/80 text-sm mb-1">Outstanding Fees</Text>
            <Text className="text-3xl font-bold text-white">{fmtINR(data?.stats.pendingFees ?? 0)}</Text>
          </View>
        </View>
      </View>

      {loading ? (
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" />
        </View>
      ) : error ? (
        <View className="flex-1 justify-center items-center px-8">
          <Text className="text-on-surface-variant text-center mb-4">{error}</Text>
          <TouchableOpacity className="bg-primary rounded-lg px-6 py-3" onPress={() => void load()}>
            <Text className="text-white font-semibold">Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>

          <Text className="text-lg font-bold text-on-surface mb-4">Quick Actions</Text>
          <View className="flex-row flex-wrap justify-between mb-8">
            {[
              { label: "Timetable", icon: "📅", route: "Timetable" },
              { label: "Attendance", icon: "✅", route: "Attendance" },
              { label: "Pay Fees", icon: "💳", route: "Fees" },
              { label: "Results", icon: "📊", route: "Results" },
            ].map((action) => (
              <TouchableOpacity key={action.label} onPress={() => navigation.navigate(action.route)}
                className="items-center bg-white border border-surface-container-highest w-[48%] py-4 mb-3 rounded-xl shadow-sm">
                <View className="w-12 h-12 bg-surface-container-low rounded-full justify-center items-center mb-2">
                  <Text className="text-primary font-bold text-xl">{action.icon}</Text>
                </View>
                <Text className="text-on-surface font-medium">{action.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text className="text-lg font-bold text-on-surface mb-4">Recent Grades</Text>
          <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-10">
            {recentGrades.length === 0 && (
              <Text className="text-on-surface-variant text-sm py-3">No published results yet.</Text>
            )}
            {recentGrades.map((g, index) => (
              <View key={index} className={`flex-row justify-between items-center py-3 ${index !== recentGrades.length - 1 ? 'border-b border-surface-container-low' : ''}`}>
                <View>
                  <Text className="text-on-surface font-semibold">{g.subject}</Text>
                  <Text className="text-on-surface-variant text-xs">Published result</Text>
                </View>
                <View className="bg-surface-container-low px-3 py-1 rounded-md">
                  <Text className="text-primary font-bold text-sm">{g.pct === null ? 'AB' : `${g.pct}%`}</Text>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
