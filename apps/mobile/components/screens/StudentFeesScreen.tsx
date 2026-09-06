import React from "react";
import { View, Text, ScrollView, TouchableOpacity } from "react-native";

export default function StudentFeesScreen() {
  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-6">Fees & Payments</Text>
        
        <View className="bg-error-container rounded-2xl p-5 shadow-sm">
          <Text className="text-on-error-container text-sm mb-1">Total Outstanding</Text>
          <Text className="text-4xl font-bold text-on-error-container mb-4">$450.00</Text>
          
          <TouchableOpacity className="bg-error rounded-xl py-3 items-center shadow-sm">
            <Text className="text-white font-bold text-lg">Pay Now</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <Text className="text-lg font-bold text-on-surface mb-4">Upcoming Dues</Text>
        <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-6">
           <View className="flex-row justify-between items-center">
              <View>
                <Text className="text-on-surface font-semibold text-lg">Term 2 Tuition</Text>
                <Text className="text-on-surface-variant text-xs mt-1">Due: June 15, 2026</Text>
              </View>
              <Text className="text-on-surface font-bold text-lg">$450.00</Text>
           </View>
        </View>

        <Text className="text-lg font-bold text-on-surface mb-4">Past Payments</Text>
        <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-10">
          {[
            { id: "RCPT-104", desc: "Term 1 Tuition", amount: "$450.00", date: "Jan 10, 2026" },
            { id: "RCPT-092", desc: "Library Fee", amount: "$50.00", date: "Jan 10, 2026" },
            { id: "RCPT-041", desc: "Uniforms", amount: "$120.00", date: "Aug 15, 2025" },
          ].map((payment, index) => (
            <View key={index} className={`flex-row justify-between items-center py-3 ${index !== 2 ? 'border-b border-surface-container-low' : ''}`}>
              <View>
                <Text className="text-on-surface font-semibold">{payment.desc}</Text>
                <Text className="text-on-surface-variant text-xs">{payment.id} • {payment.date}</Text>
              </View>
              <View className="bg-surface-container-low px-3 py-1 rounded-md">
                 <Text className="text-on-surface font-bold text-sm">{payment.amount}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
