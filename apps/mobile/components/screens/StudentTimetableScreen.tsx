import React from "react";
import { View, Text, ScrollView } from "react-native";

export default function StudentTimetableScreen() {
  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-6">Timetable</Text>
        
        <View className="flex-row justify-between">
           {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((day, i) => (
             <View key={i} className={`w-12 h-16 rounded-xl justify-center items-center ${i === 1 ? 'bg-primary' : 'bg-surface-container-highest'}`}>
                <Text className={`text-xs ${i === 1 ? 'text-white/80' : 'text-on-surface-variant'}`}>{day}</Text>
                <Text className={`text-lg font-bold ${i === 1 ? 'text-white' : 'text-on-surface'}`}>{5+i}</Text>
             </View>
           ))}
        </View>
      </View>

      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <View className="space-y-4 mb-10">
          {[
            { time: "09:00 AM", subject: "English Literature", room: "Room 101", teacher: "Mrs. Davis" },
            { time: "10:00 AM", subject: "Mathematics", room: "Room 302", teacher: "Mr. Smith", active: true },
            { time: "11:15 AM", subject: "Physics", room: "Lab 2", teacher: "Dr. Brown" },
            { time: "01:00 PM", subject: "Physical Education", room: "Gym", teacher: "Coach Miller" },
          ].map((cls, index) => (
            <View key={index} className={`rounded-2xl p-4 flex-row shadow-sm border ${cls.active ? 'bg-primary-fixed border-primary-fixed-dim' : 'bg-white border-surface-container-highest'}`}>
              <View className="w-20 border-r border-surface-container-highest mr-4 pr-2 justify-center">
                <Text className={`font-bold ${cls.active ? 'text-primary' : 'text-on-surface-variant'}`}>{cls.time}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-on-surface font-bold text-lg mb-1">{cls.subject}</Text>
                <View className="flex-row items-center justify-between">
                  <Text className="text-on-surface-variant text-xs">{cls.teacher}</Text>
                  <Text className="text-on-surface-variant text-xs font-medium">{cls.room}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
