import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { academicApi } from "../../lib/api";

export default function AdminAcademicsOverview() {
  const [classes, setClasses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    academicApi.getClasses().then(res => {
      setClasses(res.data || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-6">Academics Overview</Text>
        <View className="flex-row justify-between">
          <View className="bg-white flex-1 rounded-2xl p-4 mr-2 shadow-sm">
            <Text className="text-on-surface-variant text-xs mb-1">Total Classes</Text>
            <Text className="text-2xl font-bold text-primary">{classes.length}</Text>
          </View>
          <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm">
            <Text className="text-on-surface-variant text-xs mb-1">Total Subjects</Text>
            <Text className="text-2xl font-bold text-primary">24</Text>
          </View>
        </View>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator size="large" color="#004ac6" /> : 
          classes.map((c, i) => (
            <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4">
              <Text className="text-on-surface font-semibold text-lg">{c.name}</Text>
              <Text className="text-on-surface-variant text-sm mt-1">Capacity: {c.capacity}</Text>
            </View>
          ))
        }
      </ScrollView>
    </View>
  );
}
