import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { feeApi } from "../../lib/api";

export default function FeeStructuresScreen() {
  const [structures, setStructures] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    feeApi.getStructures().then(res => {
      setStructures(res.data || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-2">Fee Structures</Text>
        <Text className="text-on-surface-variant text-sm">Manage fee categories and amounts</Text>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#004ac6" className="mt-10" />
        ) : structures.length === 0 ? (
          <View className="items-center mt-16">
            <Text className="text-4xl mb-4">💰</Text>
            <Text className="text-on-surface-variant text-center">No fee structures defined yet.</Text>
          </View>
        ) : (
          structures.map((fs, i) => (
            <View key={i} className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-4">
              <View className="flex-row justify-between items-start mb-3">
                <View className="flex-1">
                  <Text className="text-on-surface font-bold text-lg">{fs.name}</Text>
                  <Text className="text-on-surface-variant text-sm mt-1">{fs.description || 'No description'}</Text>
                </View>
                <View className="bg-primary-container px-3 py-1 rounded-lg">
                  <Text className="text-white font-bold">${fs.amount}</Text>
                </View>
              </View>
              <View className="flex-row items-center">
                <View className="bg-surface-container-low px-2 py-0.5 rounded-md mr-2">
                  <Text className="text-on-surface-variant text-xs">
                    {fs.frequency || 'One-time'}
                  </Text>
                </View>
                {fs.classNames && (
                  <Text className="text-on-surface-variant text-xs">
                    Applied to: {fs.classNames.join(', ')}
                  </Text>
                )}
              </View>
            </View>
          ))
        )}
        <View className="h-10" />
      </ScrollView>
    </View>
  );
}
