import React from "react";
import { View, Text, ScrollView, TouchableOpacity } from "react-native";

export default function ParentDashboard({ navigation }: any) {
  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <View className="flex-row justify-between items-center mb-6">
          <View>
            <Text className="text-on-surface-variant text-sm font-medium">Child Profile</Text>
            <Text className="text-2xl font-bold text-on-surface">Emma Watson</Text>
            <Text className="text-on-surface-variant text-xs">Grade 5 - Section A</Text>
          </View>
        </View>

        <View className="bg-primary-container rounded-2xl p-5 shadow-sm">
          <Text className="text-white/80 text-sm mb-1">Upcoming Event</Text>
          <Text className="text-2xl font-bold text-white mb-2">Parent-Teacher Meeting</Text>
          <View className="flex-row items-center justify-between">
            <Text className="text-white font-medium">Tomorrow, 10:00 AM</Text>
          </View>
        </View>
      </View>

      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        
        <Text className="text-lg font-bold text-on-surface mb-4">Quick Actions</Text>
        <View className="flex-row flex-wrap justify-between mb-8">
          {[
            { label: "Timetable", icon: "📅", route: "Timetable" },
            { label: "Attendance", icon: "✅", route: "Attendance" },
            { label: "Pay Fees", icon: "💳", route: "Fees" },
            { label: "Results", icon: "📊", route: "Results" },
          ].map((action, index) => (
            <TouchableOpacity 
              key={index} 
              onPress={() => navigation.navigate(action.route)}
              className="items-center bg-white border border-surface-container-highest w-[48%] py-4 mb-3 rounded-xl shadow-sm"
            >
              <View className="w-12 h-12 bg-surface-container-low rounded-full justify-center items-center mb-2">
                <Text className="text-primary font-bold text-xl">{action.icon}</Text>
              </View>
              <Text className="text-on-surface font-medium">{action.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text className="text-lg font-bold text-on-surface mb-4">Recent Grades</Text>
        <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-10">
          {[
            { subject: "Mathematics", grade: "A+", date: "Mid-Term" },
            { subject: "Science", grade: "A", date: "Mid-Term" },
            { subject: "History", grade: "B+", date: "Unit Test" },
          ].map((grade, index) => (
            <View key={index} className={`flex-row justify-between items-center py-3 ${index !== 2 ? 'border-b border-surface-container-low' : ''}`}>
              <View>
                <Text className="text-on-surface font-semibold">{grade.subject}</Text>
                <Text className="text-on-surface-variant text-xs">{grade.date}</Text>
              </View>
              <View className="bg-surface-container-low px-3 py-1 rounded-md">
                 <Text className="text-primary font-bold text-sm">{grade.grade}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
