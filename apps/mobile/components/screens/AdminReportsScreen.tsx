import React from "react";
import { View, Text, ScrollView } from "react-native";

export default function AdminReportsScreen() {
  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-2">School Analytics</Text>
        <Text className="text-on-surface-variant text-sm">May 2026</Text>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-6">
          <Text className="font-bold text-on-surface mb-4">Attendance Trends</Text>
          <View className="h-40 justify-end flex-row items-end space-x-2">
            {[60, 80, 95, 92, 98, 85].map((val, i) => (
              <View key={i} className="bg-primary/20 flex-1 rounded-t-md mx-1" style={{ height: `${val}%` }} />
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
