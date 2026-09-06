import React from "react";
import { View, Text, ScrollView } from "react-native";

export default function StudentAttendanceScreen() {
  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-2">Attendance</Text>
        <Text className="text-on-surface-variant text-sm">May 2026</Text>
      </View>

      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <View className="flex-row justify-between mb-6">
          <View className="bg-white flex-1 rounded-2xl p-4 mr-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Present</Text>
            <Text className="text-2xl font-bold text-green-600">82 Days</Text>
          </View>
          <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Absent</Text>
            <Text className="text-2xl font-bold text-error">3 Days</Text>
          </View>
        </View>

        <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-10">
          <Text className="font-bold text-on-surface mb-4 text-lg">Monthly Overview</Text>
          <View className="flex-row flex-wrap justify-between">
            {Array.from({length: 31}).map((_, i) => {
              const isAbsent = i === 12 || i === 14;
              const isWeekend = (i + 1) % 7 === 0 || (i + 2) % 7 === 0;
              const isFuture = i > 5; // Assuming today is May 6
              
              let bgColor = "bg-surface-container-low";
              let textColor = "text-on-surface";

              if (isAbsent && !isFuture) {
                bgColor = "bg-error/10";
                textColor = "text-error";
              } else if (isWeekend && !isFuture) {
                bgColor = "bg-surface-container-highest";
                textColor = "text-on-surface-variant";
              } else if (!isFuture) {
                bgColor = "bg-primary/10";
                textColor = "text-primary";
              } else {
                bgColor = "bg-surface";
                textColor = "text-outline-variant";
              }

              return (
                <View key={i} className={`w-[13%] aspect-square justify-center items-center rounded-full mb-2 ${bgColor}`}>
                  <Text className={`font-medium ${textColor}`}>{i + 1}</Text>
                </View>
              );
            })}
          </View>
          
          <View className="flex-row justify-between mt-4 border-t border-surface-container-low pt-4">
            <View className="flex-row items-center"><View className="w-3 h-3 rounded-full bg-primary/20 mr-2"></View><Text className="text-xs text-on-surface-variant">Present</Text></View>
            <View className="flex-row items-center"><View className="w-3 h-3 rounded-full bg-error/20 mr-2"></View><Text className="text-xs text-on-surface-variant">Absent</Text></View>
            <View className="flex-row items-center"><View className="w-3 h-3 rounded-full bg-surface-container-highest mr-2"></View><Text className="text-xs text-on-surface-variant">Holiday</Text></View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
