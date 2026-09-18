import React, { useCallback, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert,
  Modal, TextInput, Platform,
} from "react-native";
import { teacherApi } from "../../lib/api";
import { leaveTypeLabel, statusLabel } from "../../lib/leave-labels";
import { useFocusEffect } from "@react-navigation/native";

// ──────────────────────────────────────────────
// Leave Approvals — the approver inbox (HOD / Principal / admins).
//
// Server-driven scope: a HOD gets only their department's requests, a
// Principal/admin gets the branch (the response's `scope` says which, and it
// becomes the subtitle so the reader knows what they are deciding over).
// PENDING first server-side; filter tabs let the approver flip through
// decided rows too. A decision posts once — a second decision on the same
// row surfaces the server's 409 "already decided" instead of overriding.
// ──────────────────────────────────────────────

type Row = {
  id: string;
  teacherName: string;
  employeeId: string;
  department: string;
  designation: string;
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

export default function LeaveApprovalsScreen() {
  const [rows, setRows] = useState<Row[]>([]);
  const [scope, setScope] = useState<"department" | "branch">("branch");
  const [filter, setFilter] = useState<"PENDING" | "APPROVED" | "REJECTED">("PENDING");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Open decision sheet: the row + chosen decision + optional note.
  const [decision, setDecision] = useState<{ row: Row; decision: "APPROVED" | "REJECTED"; note: string } | null>(null);

  const load = async () => {
    try {
      const res = await teacherApi.getLeaveApprovals();
      setRows(res.data ?? []);
      if (res.scope) setScope(res.scope);
      setError(null);
    } catch (e: any) {
      setError(e?.detail || "Could not load leave requests.");
    }
    setLoading(false);
  };

  useFocusEffect(
    useCallback(() => {
      load();
    }, []),
  );

  const decide = (row: Row, decision: "APPROVED" | "REJECTED") => {
    // Cross-platform decision sheet — Alert.prompt is iOS-only, so the
    // optional note rides in a bottom sheet instead of a system dialog.
    setDecision({ row, decision, note: "" });
  };

  const submitDecision = async () => {
    if (!decision) return;
    const { row, decision: d, note } = decision;
    setDecision(null);
    setBusyId(row.id);
    try {
      await teacherApi.decideLeaveRequest(row.id, d, note.trim() || undefined);
      // Optimistic update — the server already committed.
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: d, decisionNote: note.trim() || r.decisionNote } : r)));
    } catch (e: any) {
      Alert.alert("Not saved", e?.detail || "Could not record the decision.");
      await load(); // resync on failure (e.g. 409 already decided)
    }
    setBusyId(null);
  };

  const visible = rows.filter((r) => r.status === filter);
  const counts = {
    PENDING: rows.filter((r) => r.status === "PENDING").length,
    APPROVED: rows.filter((r) => r.status === "APPROVED").length,
    REJECTED: rows.filter((r) => r.status === "REJECTED").length,
  };

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-1">Leave Approvals</Text>
        <Text className="text-on-surface-variant text-sm">
          {scope === "department" ? "Requests from your department" : "Requests from your branch"}
        </Text>
      </View>

      {/* Filter tabs */}
      <View className="flex-row px-4 pt-4 pb-2">
        {(["PENDING", "APPROVED", "REJECTED"] as const).map((f) => (
          <TouchableOpacity
            key={f}
            onPress={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full mr-2 ${filter === f ? "bg-primary" : "bg-surface-container-low border border-surface-container-highest"}`}
          >
            <Text className={`text-xs font-semibold ${filter === f ? "text-white" : "text-on-surface-variant"}`}>
              {statusLabel(f)} ({counts[f]})
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
            <Text className="text-4xl mb-3">✅</Text>
            <Text className="text-on-surface-variant text-center px-8">
              No {statusLabel(filter).toLowerCase()} requests right now.
            </Text>
          </View>
        ) : (
          visible.map((r) => {
            const s = STATUS_STYLES[r.status] ?? STATUS_STYLES.PENDING;
            const pending = r.status === "PENDING";
            return (
              <View key={r.id} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-3">
                <View className="flex-row justify-between items-start">
                  <View className="flex-1 mr-2">
                    <Text className="text-on-surface font-semibold text-base">{r.teacherName}</Text>
                    <Text className="text-on-surface-variant text-xs mt-0.5">
                      {r.department}{r.designation ? ` · ${r.designation}` : ""} · {r.employeeId}
                    </Text>
                  </View>
                  <View className={`px-3 py-1 rounded-full ${s.chip}`}>
                    <Text className={`font-bold text-xs ${s.text}`}>{statusLabel(r.status)}</Text>
                  </View>
                </View>

                <View className="flex-row items-center mt-3">
                  <View className="bg-surface-container-low rounded-lg px-2.5 py-1">
                    <Text className="text-on-surface text-xs font-semibold">{leaveTypeLabel(r.leaveType)}</Text>
                  </View>
                  <Text className="text-on-surface-variant text-xs ml-2">
                    {fmtDate(r.startDate)} → {fmtDate(r.endDate)}
                  </Text>
                </View>

                {r.reason ? (
                  <Text className="text-on-surface-variant text-sm mt-2" numberOfLines={3}>{r.reason}</Text>
                ) : null}

                {/* Decision stamp — visible on APPROVED/REJECTED rows in the
                    inbox too, so an approver re-opening the list sees who
                    already decided what. */}
                {!pending && (r.approvedBy || r.decidedAt) && (
                  <Text className="text-on-surface-variant text-xs mt-2">
                    {r.status === "APPROVED" ? "Approved" : "Rejected"}
                    {r.approvedBy ? ` by ${r.approvedBy}` : ""}
                    {r.decidedAt ? ` · ${fmtDate(r.decidedAt)}` : ""}
                  </Text>
                )}

                {pending && (
                  <View className="flex-row mt-3">
                    <TouchableOpacity
                      className={`flex-1 bg-error/10 rounded-xl py-2.5 items-center mr-2 ${busyId === r.id ? "opacity-50" : ""}`}
                      disabled={busyId === r.id}
                      onPress={() => decide(r, "REJECTED")}
                    >
                      <Text className="text-error font-bold text-sm">Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      className={`flex-1 bg-primary rounded-xl py-2.5 items-center ml-2 ${busyId === r.id ? "opacity-50" : ""}`}
                      disabled={busyId === r.id}
                      onPress={() => decide(r, "APPROVED")}
                    >
                      {busyId === r.id
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Text className="text-white font-bold text-sm">Approve</Text>}
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })
        )}
        <View className="h-10" />
      </ScrollView>

      {/* Decision sheet — confirm with an optional note for the teacher. */}
      <Modal visible={!!decision} animationType="slide" transparent onRequestClose={() => setDecision(null)}>
        <View className="flex-1 justify-end bg-black/40">
          <View className={`bg-surface rounded-t-3xl p-6 ${Platform.OS === "ios" ? "pb-10" : "pb-8"}`}>
            {decision && (
              <>
                <View className="flex-row justify-between items-center mb-1">
                  <Text className="text-xl font-bold text-on-surface">
                    {decision.decision === "APPROVED" ? "Approve leave?" : "Reject leave?"}
                  </Text>
                  <TouchableOpacity onPress={() => setDecision(null)}>
                    <Text className="text-on-surface-variant text-lg">✕</Text>
                  </TouchableOpacity>
                </View>
                <Text className="text-on-surface-variant text-sm mb-4">
                  {decision.row.teacherName} · {leaveTypeLabel(decision.row.leaveType)} · {fmtDate(decision.row.startDate)} → {fmtDate(decision.row.endDate)}
                </Text>

                <Text className="text-on-surface-variant text-xs mb-1">Note for the teacher (optional)</Text>
                <TextInput
                  className="bg-white border border-surface-container-highest rounded-xl px-4 py-3 text-on-surface mb-5"
                  placeholder={decision.decision === "APPROVED" ? "e.g. Enjoy your break — classes covered." : "e.g. Exams that week — please reapply later."}
                  placeholderTextColor="#737686"
                  value={decision.note}
                  onChangeText={(note) => setDecision({ ...decision, note })}
                  multiline
                  numberOfLines={3}
                  autoFocus
                />

                <TouchableOpacity
                  className={`rounded-xl py-4 items-center`}
                  style={{ backgroundColor: decision.decision === "APPROVED" ? "#004ac6" : "#b3261e" }}
                  onPress={submitDecision}
                >
                  <Text className="text-white font-semibold text-base">
                    Confirm {decision.decision === "APPROVED" ? "Approval" : "Rejection"}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
