import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { teacherApi } from "../../lib/api";

export default function TeacherTimetableScreen() {
  const [timetable, setTimetable] = useState<any[]>([]);
  const [className, setClassName] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    teacherApi.getMyTimetable().then(res => {
      setClassName(res.className || '');
      setTimetable(res.timetable || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-1">My Timetable</Text>
        {className ? <Text className="text-on-surface-variant text-sm">{className}</Text> : null}
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#004ac6" className="mt-10" />
        ) : timetable.length === 0 ? (
          <View className="items-center mt-16">
            <Text className="text-4xl mb-4">📅</Text>
            <Text className="text-on-surface-variant text-center">No timetable assigned yet.</Text>
          </View>
        ) : (
          timetable.map((slot, i) => (
            <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4 flex-row">
              <View className="w-20 border-r border-surface-container-highest mr-4 pr-2 justify-center">
                <Text className="text-primary font-bold">{slot.time || slot.period}</Text>
                <Text className="text-on-surface-variant text-xs mt-1">{slot.day}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-on-surface font-bold text-lg">{slot.subject}</Text>
                <View className="flex-row items-center justify-between mt-1">
                  <Text className="text-on-surface-variant text-sm">{slot.className} - {slot.sectionName}</Text>
                  <Text className="text-on-surface-variant text-xs font-medium">{slot.room || ''}</Text>
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
