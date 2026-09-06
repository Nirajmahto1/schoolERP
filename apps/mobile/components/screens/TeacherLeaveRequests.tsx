import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { teacherApi } from "../../lib/api";

export default function TeacherLeaveRequests() {
  const [leaves, setLeaves] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    teacherApi.getLeaveRequests().then(res => {
      setLeaves(res || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-6">Leave Requests</Text>
        <View className="flex-row justify-between">
          <View className="bg-white flex-1 rounded-2xl p-4 mr-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Leaves Taken</Text>
            <Text className="text-2xl font-bold text-primary">4</Text>
          </View>
          <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Allowance</Text>
            <Text className="text-2xl font-bold text-on-surface">14</Text>
          </View>
        </View>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator size="large" color="#004ac6" /> : 
          leaves.length === 0 ? <Text className="text-center mt-10 text-on-surface-variant">No leave requests found.</Text> :
          leaves.map((l, i) => (
            <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4 flex-row justify-between items-center">
              <View>
                <Text className="text-on-surface font-semibold text-lg">{l.type || 'Sick Leave'}</Text>
                <Text className="text-on-surface-variant text-sm mt-1">{l.startDate} - {l.endDate}</Text>
              </View>
              <View className={`px-3 py-1 rounded-md ${l.status === 'Approved' ? 'bg-primary/20' : 'bg-surface-container-low'}`}>
                 <Text className={`font-bold text-sm ${l.status === 'Approved' ? 'text-primary' : 'text-on-surface-variant'}`}>{l.status || 'Pending'}</Text>
              </View>
            </View>
          ))
        }
      </ScrollView>
      <TouchableOpacity className="absolute bottom-6 right-6 bg-primary w-14 h-14 rounded-full justify-center items-center shadow-lg">
        <Text className="text-white text-3xl font-light">+</Text>
      </TouchableOpacity>
    </View>
  );
}
