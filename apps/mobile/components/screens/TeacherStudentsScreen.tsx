import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, ScrollView, FlatList, TextInput, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { teacherApi } from "../../lib/api";

// ──────────────────────────────────────────────
// Students — the teacher's directory. Pick a class-section you teach
// (from /teacher/my-classes), then browse/search the live roster
// (/teacher/students). Rows show roll, admission number and gender.
// ──────────────────────────────────────────────

type MyClass = { cls: string; sub: string; classId: string; sectionId: string };
type StudentRow = {
  id: string;
  admissionNo: string;
  firstName: string;
  lastName: string;
  gender: string;
  phone?: string | null;
};

export default function TeacherStudentsScreen() {
  const [classes, setClasses] = useState<MyClass[]>([]);
  const [picked, setPicked] = useState<MyClass | null>(null);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [search, setSearch] = useState("");
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    teacherApi
      .getMyClasses()
      .then((res: any) => {
        const rows: MyClass[] = Array.isArray(res) ? res : [];
        // Dedupe by class-section (my-classes is per subject assignment).
        const seen = new Set<string>();
        const unique = rows.filter((c) => {
          const k = `${c.classId}-${c.sectionId}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        setClasses(unique);
        if (unique.length > 0) setPicked(unique[0]);
      })
      .catch((e: any) => setError(e?.detail || "Could not load your classes."))
      .finally(() => setLoadingClasses(false));
  }, []);

  const loadStudents = useCallback((cls: MyClass, query: string) => {
    setLoadingStudents(true);
    const [className, ...rest] = cls.cls.split("-");
    const sectionName = rest.join("-");
    teacherApi
      .getStudents(className.trim(), sectionName.trim(), query || undefined)
      .then((res: any) => setStudents(res?.data ?? []))
      .catch((e: any) => setError(e?.detail || "Could not load students."))
      .finally(() => setLoadingStudents(false));
  }, []);

  // Reload when the picked section changes (debounced on search text).
  useEffect(() => {
    if (!picked) return;
    const t = setTimeout(() => loadStudents(picked, search), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [picked, search, loadStudents]);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-1">Students</Text>
        <Text className="text-on-surface-variant text-sm">Rosters for the classes you teach</Text>
      </View>

      {loadingClasses ? (
        <ActivityIndicator size="large" color="#004ac6" className="mt-10" />
      ) : error && classes.length === 0 ? (
        <Text className="text-center mt-10 text-error px-8">{error}</Text>
      ) : classes.length === 0 ? (
        <View className="items-center mt-16 px-8">
          <Text className="text-4xl mb-4">🎒</Text>
          <Text className="text-on-surface-variant text-center">
            No class assignments yet. Students appear once you are assigned subjects.
          </Text>
        </View>
      ) : (
        <>
          {/* Class-section chips */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="px-4 pt-4" contentContainerStyle={{ paddingRight: 16 }}>
            {classes.map((c) => (
              <TouchableOpacity
                key={`${c.classId}-${c.sectionId}`}
                onPress={() => setPicked(c)}
                className={`px-4 py-2 rounded-full mr-2 ${picked === c ? "bg-primary" : "bg-surface-container-low border border-surface-container-highest"}`}
              >
                <Text className={`text-sm font-semibold ${picked === c ? "text-white" : "text-on-surface-variant"}`}>{c.cls}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Search */}
          <View className="px-4 pt-3">
            <TextInput
              className="bg-white border border-surface-container-highest rounded-full px-4 py-2.5 text-on-surface"
              placeholder="Search name or admission no…"
              placeholderTextColor="#737686"
              value={search}
              onChangeText={setSearch}
            />
          </View>

          {loadingStudents ? (
            <ActivityIndicator size="large" color="#004ac6" className="mt-8" />
          ) : (
            <FlatList
              className="flex-1 px-4 pt-3"
              data={students}
              keyExtractor={(s) => s.id}
              ListEmptyComponent={
                <Text className="text-center mt-10 text-on-surface-variant">No students match.</Text>
              }
              renderItem={({ item }) => (
                <View className="bg-white rounded-2xl px-4 py-3 shadow-sm border border-surface-container-highest mb-2 flex-row items-center">
                  <View className="w-10 h-10 rounded-full bg-primary/15 justify-center items-center mr-3">
                    <Text className="text-primary font-bold">{item.firstName?.[0] ?? "?"}</Text>
                  </View>
                  <View className="flex-1">
                    <Text className="text-on-surface font-semibold">{item.firstName} {item.lastName}</Text>
                    <Text className="text-on-surface-variant text-xs mt-0.5">
                      {item.admissionNo}
                      {item.phone ? ` · ${item.phone}` : ""}
                    </Text>
                  </View>
                  <Text className="text-on-surface-variant text-xs">{item.gender}</Text>
                </View>
              )}
            />
          )}
        </>
      )}
    </View>
  );
}
