import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { teacherApi } from "../../lib/api";

export default function TeacherAttendanceEntry() {
  const [students, setStudents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Mocked call for now, assuming we select a class first
    teacherApi.getStudents("10", "A").then(res => {
      setStudents(res.data || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-2">Mark Attendance</Text>
        <Text className="text-on-surface-variant text-sm">Grade 10 - Section A • May 6, 2026</Text>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator size="large" color="#004ac6" /> : 
          <View className="space-y-4 mb-6">
            {[1, 2, 3, 4, 5].map((_, i) => (
              <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest flex-row justify-between items-center">
                <Text className="text-on-surface font-semibold flex-1">Student {i + 1}</Text>
                <View className="flex-row space-x-2">
                  <TouchableOpacity className="bg-primary/20 px-3 py-1 rounded-md ml-1"><Text className="text-primary font-bold">P</Text></TouchableOpacity>
                  <TouchableOpacity className="bg-surface-container-low px-3 py-1 rounded-md ml-1"><Text className="text-on-surface-variant font-bold">A</Text></TouchableOpacity>
                  <TouchableOpacity className="bg-surface-container-low px-3 py-1 rounded-md ml-1"><Text className="text-on-surface-variant font-bold">L</Text></TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        }
        <TouchableOpacity className="w-full bg-primary rounded-lg py-4 items-center mb-10 shadow-sm">
          <Text className="text-white font-semibold text-lg">Submit Attendance</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
