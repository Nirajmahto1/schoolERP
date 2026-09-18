import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert, RefreshControl, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import RazorpayCheckout from "react-native-razorpay";
import { parentApi, studentSelfApi, checkoutApi, type CheckoutOrder } from "../../lib/api";

// ──────────────────────────────────────────────
// Fees & Payments — LIVE dues + Razorpay NATIVE checkout (Phase 9 / Gate 9).
//
// Flow (§9.1 "fee dues + pay in app"):
//   1. Load open dues — parents via children-summary, student accounts via
//      /students/my-fees (the same invoices, resolved by the token's role).
//   2. "Pay now" → POST /fees/checkout/orders. The SERVER computes the
//      amount from its own open invoices; the client never states one.
//   3. react-native-razorpay opens the native sheet with { key, order_id,
//      amount(paise), currency }. Success returns razorpay_order_id /
//      razorpay_payment_id / razorpay_signature.
//   4. verify(...) → capture inside the server's ledger transaction →
//      receipt number. The webhook may also arrive first; capture is
//      idempotent, so both paths credit exactly once.
//
// NO key material lives in the app: keyId comes from the server's order
// response. Test-mode keys work in the Expo dev client; a store build needs
// a config-plugin prebuild (the SDK ships native modules).
// ──────────────────────────────────────────────
interface Due {
  id: string;
  inv: string;
  type: string;
  amt: string;
  due: string;
  status: string;
  rawOutstanding?: number;
}

function parseAmountINR(s: string): number {
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export default function StudentFeesScreen() {
  const [dues, setDues] = useState<Due[]>([]);
  const [childId, setChildId] = useState<string | null>(null);
  const [academicYearId, setAcademicYearId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [order, setOrder] = useState<CheckoutOrder | null>(null);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      // Parents: children-summary carries open invoices per child. Student
      // accounts: /my-fees returns the same invoice list directly.
      let list: Due[] = [];
      let studentId: string | null = null;
      try {
        const summary = await parentApi.getMeChildrenSummary();
        studentId = summary.students?.[0]?.id ?? null;
        // children-summary exposes the PRIMARY child's open invoices only in
        // its stats aggregate; per-child invoice rows are the parent
        // dashboard's numbers. For the dues LIST we compute from what the
        // endpoint returns per child — fall back to /my-fees when absent.
        const perChild = (summary.students?.[0] as any)?.invoices ?? [];
        list = perChild.map((inv: any) => ({
          id: inv.id,
          inv: inv.invoiceNo,
          type: inv.type ?? 'School Fee',
          amt: `₹${Math.max(0, Number(inv.totalAmount ?? 0) - Number(inv.paidAmount ?? 0)).toLocaleString('en-IN')}`,
          due: inv.dueDate ? String(inv.dueDate).slice(0, 10) : '—',
          status: inv.status ?? 'DUE',
          rawOutstanding: Math.max(0, Number(inv.totalAmount ?? 0) - Number(inv.paidAmount ?? 0)),
        }));
      } catch {
        const mine = await studentSelfApi.getMyFees();
        list = (mine ?? []).filter((d: any) => d.status !== 'Paid');
      }
      setDues(list);
      if (studentId) {
        setChildId(studentId);
        // academicYearId is optional now — the server resolves the branch's
        // current year when the client omits it.
        const yearId = await AsyncStorage.getItem('erp_academic_year_id');
        setAcademicYearId(yearId);
      }
    } catch (e: any) {
      setError(e?.detail || 'Could not load fees.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const totalOutstanding = dues.reduce((s, d) => s + (d.rawOutstanding ?? parseAmountINR(d.amt)), 0);

  const startPayment = async () => {
    if (!childId) {
      Alert.alert('Not ready', 'No student context — open this screen from your dashboard once invoices are issued.');
      return;
    }
    setPaying(true);
    try {
      const o = await checkoutApi.createOrder(academicYearId ? { studentId: childId, academicYearId } : { studentId: childId });
      setOrder(o);
      if (!o.keyId) {
        Alert.alert('Not configured', 'This deployment has no Razorpay keys — payment is unavailable.');
        setPaying(false);
        return;
      }

      // ── Native checkout sheet (react-native-razorpay) ──
      // Amount in PAISE; the sheet returns the signature triple that the
      // server's /verify endpoint HMAC-checks before capture.
      const data = await RazorpayCheckout.open({
        key: o.keyId,
        amount: Math.round(o.amount * 100),
        currency: o.currency || 'INR',
        name: 'School Fees',
        description: o.invoices?.length === 1 ? `Invoice ${o.invoices[0].invoiceNo}` : 'Fee payment',
        order_id: o.orderId,
        theme: { color: '#5048E5' },
      });

      // ── Verify → server capture (idempotent; webhook may have won) ──
      const res = await checkoutApi.verify({
        razorpay_order_id: data.razorpay_order_id ?? o.orderId,
        razorpay_payment_id: data.razorpay_payment_id,
        razorpay_signature: data.razorpay_signature ?? '',
      });
      if (res.captured) {
        setReceipt(res.payment?.receiptNo ?? 'receipt');
        setOrder(null);
        await load(false);
      } else {
        Alert.alert('Not captured', res.reason === 'ALREADY_CAPTURED'
          ? 'This payment was already recorded.'
          : (res.reason ?? 'Payment could not be verified.'));
      }
    } catch (e: any) {
      // RazorpayCheckout errors: { code, description, ... } — user closing
      // the sheet is a normal path, not an alert-worthy failure.
      const cancelled = e?.code === 2 || /cancel|dismissed/i.test(String(e?.description ?? e?.message ?? ''));
      if (!cancelled) {
        Alert.alert('Payment failed', e?.description || e?.detail || 'Please try again.');
      }
    }
    setPaying(false);
  };

  const fmtINR = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-6">Fees & Payments</Text>

        {receipt ? (
          <View className="bg-primary-container rounded-2xl p-5 shadow-sm">
            <Text className="text-white/80 text-sm mb-1">Payment captured</Text>
            <Text className="text-2xl font-bold text-white mb-2">Receipt {receipt}</Text>
            <Text className="text-white/80 text-xs">A signed receipt is available in the web portal and was sent to your registered channels.</Text>
          </View>
        ) : (
          <View className="bg-error-container rounded-2xl p-5 shadow-sm">
            <Text className="text-on-error-container text-sm mb-1">Total Outstanding</Text>
            <Text className="text-4xl font-bold text-on-error-container mb-4">{fmtINR(totalOutstanding)}</Text>

            <TouchableOpacity
              className="bg-error rounded-xl py-3 items-center shadow-sm"
              onPress={startPayment}
              disabled={paying || dues.length === 0}
            >
              {paying
                ? <ActivityIndicator color="#fff" />
                : <Text className="text-white font-bold text-lg">Pay Now</Text>}
            </TouchableOpacity>
            {Platform.OS === 'web' && (
              <Text className="text-on-error-container text-xs mt-3 text-center">
                Payments open in the native sheet on Android/iOS builds.
              </Text>
            )}
          </View>
        )}
      </View>

      {loading ? (
        <View className="flex-1 justify-center items-center"><ActivityIndicator size="large" /></View>
      ) : error ? (
        <View className="flex-1 justify-center items-center px-8">
          <Text className="text-on-surface-variant text-center mb-4">{error}</Text>
          <TouchableOpacity className="bg-primary rounded-lg px-6 py-3" onPress={() => void load()}>
            <Text className="text-white font-semibold">Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(false); setRefreshing(false); }} />}>
          <Text className="text-lg font-bold text-on-surface mb-4">Upcoming Dues</Text>
          <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-6">
            {dues.length === 0 && <Text className="text-on-surface-variant text-sm py-3">No outstanding dues 🎉</Text>}
            {dues.map((d, index) => (
              <View key={d.id} className={`flex-row justify-between items-center ${index !== dues.length - 1 ? 'border-b border-surface-container-low' : ''}`}>
                <View>
                  <Text className="text-on-surface font-semibold text-lg">{d.type}</Text>
                  <Text className="text-on-surface-variant text-xs mt-1">{d.inv} • Due: {d.due}</Text>
                </View>
                <Text className="text-on-surface font-bold text-lg">{d.amt}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
