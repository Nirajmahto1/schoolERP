import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, TextInput } from "react-native";
import { teacherApi } from "../../lib/api";

export default function TeacherEnterMarks() {
  const [students, setStudents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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
        <Text className="text-2xl font-bold text-on-surface mb-2">Enter Marks</Text>
        <Text className="text-on-surface-variant text-sm">Grade 10 - Math • Mid-Term</Text>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator size="large" color="#004ac6" /> : 
          <View className="space-y-4 mb-6">
            {[1, 2, 3, 4, 5].map((_, i) => (
              <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest flex-row justify-between items-center">
                <Text className="text-on-surface font-semibold flex-1">Student {i + 1}</Text>
                <TextInput 
                  className="bg-surface-container-low border border-surface-container-highest rounded-lg px-3 py-2 text-center w-16 text-on-surface"
                  placeholder="00"
                  keyboardType="numeric"
                />
                <Text className="text-on-surface-variant ml-2">/ 100</Text>
              </View>
            ))}
          </View>
        }
        <TouchableOpacity className="w-full bg-primary rounded-lg py-4 items-center mb-10 shadow-sm">
          <Text className="text-white font-semibold text-lg">Save Marks</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
