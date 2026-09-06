import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { feeApi } from "../../lib/api";

export default function FinanceReportsScreen() {
  const [reports, setReports] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    feeApi.getReports().then(res => {
      setReports(res || {});
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-6">Financial Reports</Text>
        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest">
          <Text className="text-on-surface-variant text-sm mb-2">Net Balance</Text>
          <Text className="text-4xl font-bold text-primary">$115,400</Text>
        </View>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator size="large" color="#004ac6" /> : 
          <>
            <View className="flex-row justify-between mb-6">
              <View className="bg-white flex-1 rounded-2xl p-4 mr-2 shadow-sm border border-surface-container-highest">
                <Text className="text-on-surface-variant text-xs mb-1">Total Revenue</Text>
                <Text className="text-xl font-bold text-green-600">$142,500</Text>
              </View>
              <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm border border-surface-container-highest">
                <Text className="text-on-surface-variant text-xs mb-1">Total Expenses</Text>
                <Text className="text-xl font-bold text-error">$27,100</Text>
              </View>
            </View>

            <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-10">
              <Text className="font-bold text-on-surface mb-4 text-lg">Recent Transactions</Text>
              {[1, 2, 3].map((i) => (
                <View key={i} className={`flex-row justify-between items-center py-3 ${i !== 3 ? 'border-b border-surface-container-low' : ''}`}>
                  <View>
                    <Text className="text-on-surface font-semibold">Salary Payout</Text>
                    <Text className="text-on-surface-variant text-xs">May 1, 2026</Text>
                  </View>
                  <Text className="text-error font-bold">-$8,400</Text>
                </View>
              ))}
            </View>
          </>
        }
      </ScrollView>
    </View>
  );
}
