import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { feeApi } from "../../lib/api";

export default function FeeDefaultersScreen() {
  const [defaulters, setDefaulters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    feeApi.getDefaulters().then(res => {
      setDefaulters(res.data || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-2">Fee Defaulters</Text>
        <View className="bg-error-container rounded-2xl p-4 mt-4 shadow-sm">
          <Text className="text-on-error-container text-sm mb-1">Total Defaulters</Text>
          <Text className="text-3xl font-bold text-on-error-container">{defaulters.length}</Text>
        </View>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#004ac6" className="mt-10" />
        ) : defaulters.length === 0 ? (
          <View className="items-center mt-16">
            <Text className="text-4xl mb-4">✅</Text>
            <Text className="text-on-surface-variant text-center">No fee defaulters. Great!</Text>
          </View>
        ) : (
          defaulters.map((d, i) => (
            <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4 flex-row items-center">
              <View className="w-12 h-12 bg-error/10 rounded-full justify-center items-center mr-4">
                <Text className="text-error font-bold text-lg">{d.studentName?.[0] || '!'}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-on-surface font-semibold">{d.studentName}</Text>
                <Text className="text-on-surface-variant text-sm mt-0.5">{d.className} • {d.sectionName}</Text>
              </View>
              <View className="items-end">
                <Text className="text-error font-bold text-lg">${d.outstandingAmount}</Text>
                <Text className="text-on-surface-variant text-xs mt-0.5">{d.daysPastDue} days late</Text>
              </View>
            </View>
          ))
        )}
        <View className="h-10" />
      </ScrollView>
    </View>
  );
}
