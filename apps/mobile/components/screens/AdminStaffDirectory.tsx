import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TextInput, ActivityIndicator } from "react-native";
import { staffApi } from "../../lib/api";

export default function AdminStaffDirectory() {
  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    staffApi.list().then(res => {
      setStaff(res.data || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-4">Staff Directory</Text>
        <TextInput
          className="w-full bg-white border border-surface-container-highest rounded-lg px-4 py-3 text-on-surface"
          placeholder="Search by name or role..."
          placeholderTextColor="#737686"
        />
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator size="large" color="#004ac6" /> : 
          staff.map((s, i) => (
            <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4 flex-row items-center">
              <View className="w-12 h-12 bg-primary/20 rounded-full justify-center items-center mr-4">
                <Text className="text-primary font-bold">{s.firstName?.[0] || 'S'}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-on-surface font-semibold text-lg">{s.firstName} {s.lastName}</Text>
                <Text className="text-on-surface-variant text-sm">{s.department || 'Staff'}</Text>
              </View>
              <View className="bg-primary-container px-3 py-1 rounded-md">
                 <Text className="text-white font-bold text-sm">Contact</Text>
              </View>
            </View>
          ))
        }
      </ScrollView>
    </View>
  );
}
