import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { staffApi } from "../../lib/api";

export default function PayrollScreen() {
  const [payroll, setPayroll] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const now = new Date();
    staffApi.getPayroll({ month: now.getMonth() + 1, year: now.getFullYear() }).then(res => {
      setPayroll(res.data || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-2">Payroll</Text>
        <Text className="text-on-surface-variant text-sm">
          {new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}
        </Text>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#004ac6" className="mt-10" />
        ) : payroll.length === 0 ? (
          <View className="items-center mt-16">
            <Text className="text-4xl mb-4">💵</Text>
            <Text className="text-on-surface-variant text-center">No payroll records for this month.</Text>
          </View>
        ) : (
          payroll.map((p, i) => (
            <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4 flex-row items-center">
              <View className="w-12 h-12 bg-primary/10 rounded-full justify-center items-center mr-4">
                <Text className="text-primary font-bold">{p.staffName?.[0] || 'S'}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-on-surface font-semibold">{p.staffName}</Text>
                <Text className="text-on-surface-variant text-sm mt-0.5">{p.department || 'Staff'}</Text>
              </View>
              <View className="items-end">
                <Text className="text-on-surface font-bold text-lg">${p.netSalary || p.amount}</Text>
                <View className={`px-2 py-0.5 rounded-md mt-1 ${p.status === 'Paid' ? 'bg-primary/10' : 'bg-surface-container-low'}`}>
                  <Text className={`text-xs font-medium ${p.status === 'Paid' ? 'text-primary' : 'text-on-surface-variant'}`}>
                    {p.status || 'Pending'}
                  </Text>
                </View>
              </View>
            </View>
          ))
        )}
        <View className="h-10" />
      </ScrollView>
    </View>
  );
}
