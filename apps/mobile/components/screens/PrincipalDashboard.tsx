import React from "react";
import { View, Text, ScrollView, TouchableOpacity } from "react-native";

export default function PrincipalDashboard({ onLogout }: { onLogout: () => void }) {
  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <View className="flex-row justify-between items-center mb-6">
          <View>
            <Text className="text-on-surface-variant text-sm font-medium">Tuesday, May 6</Text>
            <Text className="text-2xl font-bold text-on-surface">Hello, Principal</Text>
          </View>
          <TouchableOpacity onPress={onLogout} className="w-10 h-10 bg-primary/10 rounded-full justify-center items-center">
            <Text className="text-primary text-xs font-bold">OUT</Text>
          </TouchableOpacity>
        </View>

        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest">
          <Text className="text-on-surface-variant text-sm mb-2">Total Enrollment</Text>
          <Text className="text-4xl font-bold text-primary">1,248</Text>
          <View className="flex-row mt-2 items-center">
            <Text className="text-green-600 font-medium">+24</Text>
            <Text className="text-on-surface-variant text-xs ml-1">this semester</Text>
          </View>
        </View>
      </View>

      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <View className="flex-row justify-between mb-6">
          <View className="bg-white flex-1 rounded-2xl p-4 mr-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Today's Attendance</Text>
            <Text className="text-2xl font-bold text-on-surface">94.2%</Text>
          </View>
          <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Pending Approvals</Text>
            <Text className="text-2xl font-bold text-error">12</Text>
          </View>
        </View>

        <Text className="text-lg font-bold text-on-surface mb-4">Quick Actions</Text>
        
        <View className="space-y-3 mb-10">
          {['Manage Staff', 'Announcements', 'Reports & Analytics'].map((action, index) => (
            <TouchableOpacity key={index} className="bg-white rounded-xl p-4 flex-row items-center justify-between shadow-sm border border-surface-container-highest mb-3">
              <View className="flex-row items-center">
                <View className="w-10 h-10 bg-primary/10 rounded-lg justify-center items-center mr-4">
                  <Text className="text-primary font-bold">{action[0]}</Text>
                </View>
                <Text className="text-on-surface font-medium text-lg">{action}</Text>
              </View>
              <Text className="text-on-surface-variant">→</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
