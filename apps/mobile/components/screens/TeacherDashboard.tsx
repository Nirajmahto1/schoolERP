import React from "react";
import { View, Text, ScrollView, TouchableOpacity } from "react-native";

export default function TeacherDashboard({ onLogout }: { onLogout: () => void }) {
  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <View className="flex-row justify-between items-center mb-6">
          <View>
            <Text className="text-on-surface-variant text-sm font-medium">Tuesday, May 6</Text>
            <Text className="text-2xl font-bold text-on-surface">Hello, Mr. Smith</Text>
          </View>
          <TouchableOpacity onPress={onLogout} className="w-10 h-10 bg-primary/10 rounded-full justify-center items-center">
            <Text className="text-primary text-xs font-bold">OUT</Text>
          </TouchableOpacity>
        </View>

        <View className="bg-primary-container rounded-2xl p-5 shadow-sm">
          <Text className="text-white/80 text-sm mb-1">Next Class</Text>
          <Text className="text-2xl font-bold text-white mb-2">Grade 10 - Mathematics</Text>
          <View className="flex-row items-center justify-between">
            <Text className="text-white font-medium">10:30 AM - 11:15 AM</Text>
            <View className="bg-white/20 px-3 py-1 rounded-full">
              <Text className="text-white text-xs font-bold">Room 302</Text>
            </View>
          </View>
        </View>
      </View>

      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <View className="flex-row justify-between items-end mb-4">
          <Text className="text-lg font-bold text-on-surface">Today's Schedule</Text>
          <Text className="text-primary text-sm font-medium">View All</Text>
        </View>

        <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-6">
          {[
            { time: "09:00 AM", subject: "Grade 9 - Physics", status: "Completed" },
            { time: "10:30 AM", subject: "Grade 10 - Math", status: "Upcoming" },
            { time: "01:00 PM", subject: "Grade 11 - Calculus", status: "Upcoming" },
          ].map((cls, index) => (
            <View key={index} className={`flex-row items-center py-3 ${index !== 2 ? 'border-b border-surface-container-low' : ''}`}>
              <Text className="w-20 text-on-surface-variant font-medium text-sm">{cls.time}</Text>
              <View className="flex-1 ml-2">
                <Text className="text-on-surface font-semibold">{cls.subject}</Text>
              </View>
              <View className={`px-2 py-1 rounded-md ${cls.status === 'Completed' ? 'bg-surface-container-highest' : 'bg-primary/10'}`}>
                 <Text className={`text-xs font-bold ${cls.status === 'Completed' ? 'text-on-surface-variant' : 'text-primary'}`}>{cls.status}</Text>
              </View>
            </View>
          ))}
        </View>

        <Text className="text-lg font-bold text-on-surface mb-4">Tasks</Text>
        
        <View className="space-y-3 mb-10">
          <TouchableOpacity className="bg-white rounded-xl p-4 flex-row items-center justify-between shadow-sm border border-surface-container-highest mb-3">
            <View className="flex-row items-center">
              <View className="w-10 h-10 bg-primary/10 rounded-lg justify-center items-center mr-4">
                <Text className="text-primary font-bold">A</Text>
              </View>
              <View>
                <Text className="text-on-surface font-medium text-lg">Mark Attendance</Text>
                <Text className="text-on-surface-variant text-xs">For Grade 10 - Math</Text>
              </View>
            </View>
          </TouchableOpacity>
          <TouchableOpacity className="bg-white rounded-xl p-4 flex-row items-center justify-between shadow-sm border border-surface-container-highest mb-3">
            <View className="flex-row items-center">
              <View className="w-10 h-10 bg-error/10 rounded-lg justify-center items-center mr-4">
                <Text className="text-error font-bold">G</Text>
              </View>
              <View>
                <Text className="text-on-surface font-medium text-lg">Grade Assignments</Text>
                <Text className="text-error text-xs font-medium">3 Pending</Text>
              </View>
            </View>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}
