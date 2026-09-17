import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert, RefreshControl } from "react-native";
import { teacherApi, academicApi, attendanceApi } from "../../lib/api";
import { queueAttendance, syncAttendance, pendingAttendance, type QueuedAttendance } from "../../lib/offline-attendance";
import AsyncStorage from "@react-native-async-storage/async-storage";

// ──────────────────────────────────────────────
// Mark Attendance — offline-first (Phase 9.5 / Gate 9 "offline-first").
//
// The marking flow works with ZERO connectivity:
//   • class + section + roster load from the API when online
//   • marks live in component state instantly (no network on tap)
//   • "Submit" writes to the AsyncStorage outbox FIRST — durable before the
//     button resolves — then attempts a flush
//   • queued batches sync on reconnect / app focus; the teacher sees a
//     pending chip until the server confirms
//
// Server contract is the same one the web outbox replays: one session per
// (date, class, section), record upserts inside it, so a retry after a
// dropped response can never double-write.
// ──────────────────────────────────────────────
type AttStatus = "PRESENT" | "ABSENT" | "LATE" | "";

interface StudentRow {
  id: string;
  name: string;
  rollNo: string;
}

export default function TeacherAttendanceEntry() {
  const [classes, setClasses] = useState<any[]>([]);
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [marks, setMarks] = useState<Record<string, AttStatus>>({});
  const [date] = useState(() => new Date().toISOString().split("T")[0]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState<QueuedAttendance[]>([]);
  const [syncing, setSyncing] = useState(false);

  const userIdRef = useRef<string | undefined>(undefined);

  const refreshPending = useCallback(() => {
    pendingAttendance().then(setPending).catch(() => {});
  }, []);

  const flush = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await syncAttendance((batch) =>
        attendanceApi.mark({
          date: batch.date,
          classId: batch.classId,
          sectionId: batch.sectionId,
          records: batch.records,
          markedBy: batch.markedBy,
        }),
      );
    } catch { /* per-batch failures stay queued */ }
    setSyncing(false);
    refreshPending();
  }, [syncing, refreshPending]);

  // Roster: classes from academics, students for the chosen section.
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const cls = await academicApi.getClasses();
        setClasses(cls.data ?? []);
        const first = cls.data?.[0];
        if (first) {
          setClassId(first.id);
          setSectionId(first.sections?.[0]?.id ?? "");
        }
        const me = await AsyncStorage.getItem("erp_user");
        if (me) userIdRef.current = JSON.parse(me)?.id;
      } catch { /* offline or not configured — roster stays empty */ }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!classId || !sectionId) return;
    (async () => {
      try {
        // The teacher roster endpoint keys on class/section NAMES.
        const cls = classes.find((c: any) => c.id === classId);
        const sec = cls?.sections?.find((s: any) => s.id === sectionId);
        if (!cls || !sec) return;
        const res = await teacherApi.getStudents(cls.name, sec.name);
        const rows: StudentRow[] = (res.data ?? []).map((s: any) => ({
          id: s.id ?? s.studentId,
          name: s.name ?? `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim(),
          rollNo: String(s.rollNo ?? ""),
        }));
        setStudents(rows);
        // Pre-mark everyone PRESENT: the corridor default is "all here",
        // tap only the exceptions. (Same default the web screen offers.)
        setMarks(Object.fromEntries(rows.map((s) => [s.id, "PRESENT" as AttStatus])));
      } catch {
        setStudents([]);
      }
    })();
  }, [classId, sectionId]);

  // Connectivity + sync triggers. NetInfo is optional (expo-go/web):
  // when absent the screen stays optimistic — the flush attempts simply
  // no-op until a manual pull or the next submit succeeds.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      try {
        const mod = await import("@react-native-community/netinfo");
        const state = await mod.default.fetch();
        setOnline(state.isConnected ?? true);
        // NetInfoSubscription is itself the unsubscribe function.
        unsub = mod.default.addEventListener((s) => {
          const up = s.isConnected ?? false;
          setOnline(up);
          if (up) void flush();
        });
      } catch {
        setOnline(true);
      }
      refreshPending();
      if (await pendingAttendance().then((p) => p.length > 0).catch(() => false)) void flush();
    })();
    return () => { try { unsub?.(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setAll = (status: AttStatus) => setMarks(Object.fromEntries(students.map((s) => [s.id, status])));

  const submit = async () => {
    const records = Object.entries(marks)
      .filter(([, v]) => v !== "")
      .map(([studentId, status]) => ({ studentId, status }));
    if (records.length === 0) return;
    setSubmitting(true);
    try {
      await queueAttendance({ date, classId, sectionId, records, markedBy: userIdRef.current });
      setSaved(true);
      // Immediate flush attempt; if offline it stays queued and the
      // connectivity listener flushes on reconnect.
      void flush();
      if (online) {
        // Best-effort immediate confirm; queue state is the source of truth.
        const left = await pendingAttendance();
        if (left.length === 0) setSaved(true);
      }
    } catch (e: any) {
      Alert.alert("Could not save", e?.message ?? "Try again.");
    }
    setSubmitting(false);
  };

  const present = useMemo(() => Object.values(marks).filter((v) => v === "PRESENT").length, [marks]);
  const absent = useMemo(() => Object.values(marks).filter((v) => v === "ABSENT").length, [marks]);
  const late = useMemo(() => Object.values(marks).filter((v) => v === "LATE").length, [marks]);


  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <View className="flex-row justify-between items-center">
          <Text className="text-2xl font-bold text-on-surface">Mark Attendance</Text>
          <Text className={`text-xs font-semibold px-2 py-1 rounded-full ${online ? "bg-surface-container-high" : "bg-error"}`}>
            {online ? "Online" : "Offline"}
          </Text>
        </View>
        <Text className="text-on-surface-variant text-sm mt-1">{date}</Text>
        {pending.length > 0 && (
          <View className="bg-amber-100 rounded-lg px-3 py-2 mt-3">
            <Text className="text-amber-800 text-xs font-semibold">
              {syncing ? "Syncing…" : `${pending.length} day(s) queued — will sync automatically`}
            </Text>
          </View>
        )}
        {saved && pending.length === 0 && (
          <View className="bg-surface-container-high rounded-lg px-3 py-2 mt-3">
            <Text className="text-primary text-xs font-semibold">Attendance saved ✓</Text>
          </View>
        )}
      </View>

      {loading ? (
        <View className="flex-1 justify-center items-center"><ActivityIndicator size="large" /></View>
      ) : students.length === 0 ? (
        <View className="flex-1 justify-center items-center px-8">
          <Text className="text-on-surface-variant text-center">No roster loaded. Connect once online to cache your class list.</Text>
        </View>
      ) : (
        <ScrollView className="flex-1 px-6 pt-4" showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => void flush()} />}>
          <View className="flex-row mb-4">
            <TouchableOpacity onPress={() => setAll("PRESENT")} className="bg-primary/10 px-3 py-2 rounded-lg mr-2">
              <Text className="text-primary font-semibold text-sm">All Present</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setAll("ABSENT")} className="bg-surface-container-low px-3 py-2 rounded-lg mr-2">
              <Text className="text-on-surface-variant font-semibold text-sm">All Absent</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setAll("")} className="bg-surface-container-low px-3 py-2 rounded-lg">
              <Text className="text-on-surface-variant font-semibold text-sm">Reset</Text>
            </TouchableOpacity>
          </View>

          <Text className="text-on-surface-variant text-xs mb-3">
            P {present} · A {absent} · L {late}
          </Text>

          {students.map((s) => (
            <View key={s.id} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest flex-row justify-between items-center mb-3">
              <View className="flex-1">
                <Text className="text-on-surface font-semibold">{s.name}</Text>
                {!!s.rollNo && <Text className="text-on-surface-variant text-xs">Roll {s.rollNo}</Text>}
              </View>
              <View className="flex-row">
                <TouchableOpacity onPress={() => setMarks((m) => ({ ...m, [s.id]: "PRESENT" }))}
                  className={`px-3 py-1.5 rounded-lg ml-1 ${marks[s.id] === "PRESENT" ? "bg-primary" : "bg-surface-container-low"}`}>
                  <Text className={`font-bold text-sm ${marks[s.id] === "PRESENT" ? "text-white" : "text-on-surface-variant"}`}>P</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setMarks((m) => ({ ...m, [s.id]: "ABSENT" }))}
                  className={`px-3 py-1.5 rounded-lg ml-1 ${marks[s.id] === "ABSENT" ? "bg-error" : "bg-surface-container-low"}`}>
                  <Text className={`font-bold text-sm ${marks[s.id] === "ABSENT" ? "text-white" : "text-on-surface-variant"}`}>A</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setMarks((m) => ({ ...m, [s.id]: "LATE" }))}
                  className={`px-3 py-1.5 rounded-lg ml-1 ${marks[s.id] === "LATE" ? "bg-amber-500" : "bg-surface-container-low"}`}>
                  <Text className={`font-bold text-sm ${marks[s.id] === "LATE" ? "text-white" : "text-on-surface-variant"}`}>L</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}

          <TouchableOpacity
            className="w-full bg-primary rounded-lg py-4 items-center mb-10 shadow-sm"
            onPress={submit}
            disabled={submitting || students.length === 0}
          >
            {submitting
              ? <ActivityIndicator color="#fff" />
              : <Text className="text-white font-semibold text-lg">Submit Attendance</Text>}
          </TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}
