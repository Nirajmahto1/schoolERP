import React, { useCallback, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Modal, Platform,
} from "react-native";
import { teacherApi } from "../../lib/api";
import { useFocusEffect } from "@react-navigation/native";

// ──────────────────────────────────────────────
// My Leaves — real leave_requests for the logged-in teacher.
// Filter tabs (All / Pending / Approved / Rejected), live balance card,
// and an apply sheet (leave type, dates, reason) that POSTs and refreshes.
// ──────────────────────────────────────────────

type LeaveRow = {
  id: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
};

const STATUS_STYLES: Record<string, { chip: string; text: string }> = {
  APPROVED: { chip: "bg-primary/15", text: "text-primary" },
  REJECTED: { chip: "bg-error/15", text: "text-error" },
  PENDING: { chip: "bg-amber-500/15", text: "text-amber-600" },
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

export default function TeacherLeaveRequests() {
  const [leaves, setLeaves] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"ALL" | "PENDING" | "APPROVED" | "REJECTED">("ALL");

  // Apply sheet state
  const [sheetOpen, setSheetOpen] = useState(false);
  const [leaveType, setLeaveType] = useState("SICK");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    try {
      const res = await teacherApi.getLeaveRequests();
      setLeaves(Array.isArray(res) ? res : []);
      setError(null);
    } catch (e: any) {
      setError(e?.detail || "Could not load your leave requests.");
    }
    setLoading(false);
  };

  useFocusEffect(
    useCallback(() => {
      load();
    }, []),
  );

  const submit = async () => {
    if (!fromDate || !toDate || !reason.trim()) return;
    setSubmitting(true);
    try {
      await teacherApi.createLeaveRequest({ leaveType, startDate: fromDate, endDate: toDate, reason: reason.trim() });
      setSheetOpen(false);
      setFromDate(""); setToDate(""); setReason("");
      await load();
    } catch (e: any) {
      // surface server detail (e.g. 'Staff not found')
      setError(e?.detail || "Could not submit the request.");
    }
    setSubmitting(false);
  };

  const counts = {
    ALL: leaves.length,
    PENDING: leaves.filter((l) => l.status === "PENDING").length,
    APPROVED: leaves.filter((l) => l.status === "APPROVED").length,
    REJECTED: leaves.filter((l) => l.status === "REJECTED").length,
  };
  const visible = filter === "ALL" ? leaves : leaves.filter((l) => l.status === filter);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-4">My Leaves</Text>
        <View className="flex-row justify-between">
          <View className="bg-white flex-1 rounded-2xl p-4 mr-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Total requests</Text>
            <Text className="text-2xl font-bold text-primary">{leaves.length}</Text>
          </View>
          <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Approved</Text>
            <Text className="text-2xl font-bold text-on-surface">{counts.APPROVED}</Text>
          </View>
        </View>
      </View>

      {/* Filter tabs */}
      <View className="flex-row px-4 pt-4 pb-2">
        {(["ALL", "PENDING", "APPROVED", "REJECTED"] as const).map((f) => (
          <TouchableOpacity
            key={f}
            onPress={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full mr-2 ${filter === f ? "bg-primary" : "bg-surface-container-low border border-surface-container-highest"}`}
          >
            <Text className={`text-xs font-semibold ${filter === f ? "text-white" : "text-on-surface-variant"}`}>
              {f}{f !== "ALL" ? ` (${counts[f]})` : ""}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView className="flex-1 px-4" showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#004ac6" className="mt-10" />
        ) : error ? (
          <Text className="text-center mt-10 text-error px-6">{error}</Text>
        ) : visible.length === 0 ? (
          <View className="items-center mt-14">
            <Text className="text-4xl mb-3">🗓️</Text>
            <Text className="text-on-surface-variant text-center">No {filter !== "ALL" ? filter.toLowerCase() + " " : ""}leave requests.</Text>
          </View>
        ) : (
          visible.map((l) => {
            const s = STATUS_STYLES[l.status] ?? STATUS_STYLES.PENDING;
            return (
              <View key={l.id} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-3">
                <View className="flex-row justify-between items-center">
                  <Text className="text-on-surface font-semibold text-base">{l.leaveType}</Text>
                  <View className={`px-3 py-1 rounded-full ${s.chip}`}>
                    <Text className={`font-bold text-xs ${s.text}`}>{l.status}</Text>
                  </View>
                </View>
                <Text className="text-on-surface-variant text-sm mt-1">
                  {fmtDate(l.startDate)} → {fmtDate(l.endDate)}
                </Text>
                {l.reason ? (
                  <Text className="text-on-surface-variant text-sm mt-2" numberOfLines={2}>{l.reason}</Text>
                ) : null}
              </View>
            );
          })
        )}
        <View className="h-24" />
      </ScrollView>

      {/* Apply FAB */}
      <TouchableOpacity
        className="absolute bottom-6 right-6 bg-primary w-14 h-14 rounded-full justify-center items-center shadow-lg"
        onPress={() => setSheetOpen(true)}
      >
        <Text className="text-white text-2xl font-bold">+</Text>
      </TouchableOpacity>

      {/* Apply sheet */}
      <Modal visible={sheetOpen} animationType="slide" transparent onRequestClose={() => setSheetOpen(false)}>
        <View className="flex-1 justify-end bg-black/40">
          <View className={`bg-surface rounded-t-3xl p-6 ${Platform.OS === "ios" ? "pb-10" : "pb-8"}`}>
            <View className="flex-row justify-between items-center mb-4">
              <Text className="text-xl font-bold text-on-surface">Apply for leave</Text>
              <TouchableOpacity onPress={() => setSheetOpen(false)}>
                <Text className="text-on-surface-variant text-lg">✕</Text>
              </TouchableOpacity>
            </View>

            <Text className="text-on-surface-variant text-xs mb-1">Leave type</Text>
            <View className="flex-row flex-wrap mb-4">
              {["SICK", "CASUAL", "EARNED", "MATERNITY", "DUTY", "UNPAID"].map((t) => (
                <TouchableOpacity
                  key={t}
                  onPress={() => setLeaveType(t)}
                  className={`px-3 py-1.5 rounded-full mr-2 mb-2 ${leaveType === t ? "bg-primary" : "bg-surface-container-low border border-surface-container-highest"}`}
                >
                  <Text className={`text-xs font-semibold ${leaveType === t ? "text-white" : "text-on-surface-variant"}`}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text className="text-on-surface-variant text-xs mb-1">From (YYYY-MM-DD)</Text>
            <TextInput
              className="bg-white border border-surface-container-highest rounded-xl px-4 py-3 text-on-surface mb-3"
              placeholder="2026-09-25"
              placeholderTextColor="#737686"
              value={fromDate}
              onChangeText={setFromDate}
              autoCapitalize="none"
            />
            <Text className="text-on-surface-variant text-xs mb-1">To (YYYY-MM-DD)</Text>
            <TextInput
              className="bg-white border border-surface-container-highest rounded-xl px-4 py-3 text-on-surface mb-3"
              placeholder="2026-09-26"
              placeholderTextColor="#737686"
              value={toDate}
              onChangeText={setToDate}
              autoCapitalize="none"
            />
            <Text className="text-on-surface-variant text-xs mb-1">Reason</Text>
            <TextInput
              className="bg-white border border-surface-container-highest rounded-xl px-4 py-3 text-on-surface mb-5"
              placeholder="Why do you need this leave?"
              placeholderTextColor="#737686"
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={3}
            />

            <TouchableOpacity
              className={`rounded-xl py-4 items-center ${!fromDate || !toDate || !reason.trim() ? "bg-primary/40" : "bg-primary"}`}
              onPress={submit}
              disabled={!fromDate || !toDate || !reason.trim() || submitting}
            >
              {submitting
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text className="text-white font-semibold text-base">Submit request</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}
