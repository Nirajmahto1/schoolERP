import React, { useCallback, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Modal, Platform,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { teacherApi } from "../../lib/api";
import { leaveTypeLabel, statusLabel } from "../../lib/leave-labels";
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
  decisionNote?: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  approvedBy?: string | null;
  decidedAt?: string | null;
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

/** Date → the YYYY-MM-DD the API's `new Date(...)` parses as a calendar day. */
function toApiDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Start of day (local) — the comparison basis for min dates. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function TeacherLeaveRequests() {
  const [leaves, setLeaves] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"ALL" | "PENDING" | "APPROVED" | "REJECTED">("ALL");

  // Apply sheet state. Dates are real Date objects (the pickers' native
  // value); they serialize to YYYY-MM-DD only at submit time.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [leaveType, setLeaveType] = useState("SICK");
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Android: the picker is a modal dialog — mount it while picking, unmount
  // on the change/dismiss event. iOS: rendered inline below the field.
  const [showFrom, setShowFrom] = useState(false);
  const [showTo, setShowTo] = useState(false);

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
      await teacherApi.createLeaveRequest({
        leaveType,
        startDate: toApiDate(fromDate),
        endDate: toApiDate(toDate),
        reason: reason.trim(),
      });
      setSheetOpen(false);
      setFromDate(null); setToDate(null); setReason("");
      await load();
    } catch (e: any) {
      // surface server detail (e.g. 'Staff not found')
      setError(e?.detail || "Could not submit the request.");
    }
    setSubmitting(false);
  };

  const valid = !!fromDate && !!toDate && !!reason.trim();

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
                  <Text className="text-on-surface font-semibold text-base">{leaveTypeLabel(l.leaveType)}</Text>
                  <View className={`px-3 py-1 rounded-full ${s.chip}`}>
                    <Text className={`font-bold text-xs ${s.text}`}>{statusLabel(l.status)}</Text>
                  </View>
                </View>
                <Text className="text-on-surface-variant text-sm mt-1">
                  {fmtDate(l.startDate)} → {fmtDate(l.endDate)}
                </Text>
                {l.reason ? (
                  <Text className="text-on-surface-variant text-sm mt-2" numberOfLines={2}>{l.reason}</Text>
                ) : null}

                {/* Decision stamp — who decided, their note, and when. Only on
                    decided rows; PENDING shows nothing. */}
                {l.status !== "PENDING" && (l.approvedBy || l.decisionNote || l.decidedAt) && (
                  <View className="mt-3 rounded-xl bg-surface-container-low p-3">
                    <View className="flex-row items-center">
                      <Text className="text-on-surface text-xs">
                        <Text className="font-bold">{l.status === "APPROVED" ? "Approved" : "Rejected"}</Text>
                        {l.approvedBy ? ` by ${l.approvedBy}` : ""}
                        {l.decidedAt ? ` · ${fmtDate(l.decidedAt)}` : ""}
                      </Text>
                    </View>
                    {l.decisionNote ? (
                      <Text className="text-on-surface-variant text-xs mt-1">“{l.decisionNote}”</Text>
                    ) : null}
                  </View>
                )}
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
                  <Text className={`text-xs font-semibold ${leaveType === t ? "text-white" : "text-on-surface-variant"}`}>{leaveTypeLabel(t)}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* From — tap to open the native calendar. Android pops a modal
                dialog; iOS renders the wheel inline below the field. */}
            <Text className="text-on-surface-variant text-xs mb-1">From</Text>
            <TouchableOpacity
              className="bg-white border border-surface-container-highest rounded-xl px-4 py-3.5 mb-3 flex-row justify-between items-center"
              onPress={() => { setShowTo(false); setShowFrom(true); }}
            >
              <Text className={`text-base ${fromDate ? "text-on-surface" : "text-gray-400"}`}>
                {fromDate ? fmtDate(fromDate.toISOString()) : "Pick start date"}
              </Text>
              <Text className="text-primary">📅</Text>
            </TouchableOpacity>
            {showFrom && (
              <DateTimePicker
                value={fromDate ?? toDate ?? startOfToday()}
                mode="date"
                display={Platform.OS === "ios" ? "inline" : "default"}
                minimumDate={startOfToday()}
                onChange={(_e, d) => {
                  if (Platform.OS === "android") setShowFrom(false);
                  if (d) {
                    setFromDate(d);
                    // Keep the range coherent: move "to" forward if it now
                    // precedes "from" (or has not been picked yet).
                    if (!toDate || d > toDate) setToDate(d);
                  }
                }}
              />
            )}

            {/* To — same pattern, floored at the chosen start date. */}
            <Text className="text-on-surface-variant text-xs mb-1">To</Text>
            <TouchableOpacity
              className="bg-white border border-surface-container-highest rounded-xl px-4 py-3.5 mb-3 flex-row justify-between items-center"
              onPress={() => { setShowFrom(false); setShowTo(true); }}
            >
              <Text className={`text-base ${toDate ? "text-on-surface" : "text-gray-400"}`}>
                {toDate ? fmtDate(toDate.toISOString()) : "Pick end date"}
              </Text>
              <Text className="text-primary">📅</Text>
            </TouchableOpacity>
            {showTo && (
              <DateTimePicker
                value={toDate ?? fromDate ?? startOfToday()}
                mode="date"
                display={Platform.OS === "ios" ? "inline" : "default"}
                minimumDate={fromDate ?? startOfToday()}
                onChange={(_e, d) => {
                  if (Platform.OS === "android") setShowTo(false);
                  if (d) setToDate(d);
                }}
              />
            )}
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
              className={`rounded-xl py-4 items-center ${!valid ? "bg-primary/40" : "bg-primary"}`}
              onPress={submit}
              disabled={!valid || submitting}
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
