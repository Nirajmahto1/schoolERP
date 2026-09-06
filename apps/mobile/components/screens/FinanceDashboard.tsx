import React from "react";
import { View, Text, ScrollView, TouchableOpacity } from "react-native";

export default function FinanceDashboard({ onLogout }: { onLogout: () => void }) {
  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <View className="flex-row justify-between items-center mb-6">
          <View>
            <Text className="text-on-surface-variant text-sm font-medium">Tuesday, May 6</Text>
            <Text className="text-2xl font-bold text-on-surface">Finance Overview</Text>
          </View>
          <TouchableOpacity onPress={onLogout} className="w-10 h-10 bg-primary/10 rounded-full justify-center items-center">
            <Text className="text-primary text-xs font-bold">OUT</Text>
          </TouchableOpacity>
        </View>

        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest">
          <Text className="text-on-surface-variant text-sm mb-2">Total Revenue Collected</Text>
          <Text className="text-4xl font-bold text-on-surface">$142,500</Text>
          <View className="flex-row mt-2 items-center">
            <Text className="text-green-600 font-medium">85%</Text>
            <Text className="text-on-surface-variant text-xs ml-1">of expected term revenue</Text>
          </View>
        </View>
      </View>

      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <View className="flex-row justify-between mb-6">
          <View className="bg-white flex-1 rounded-2xl p-4 mr-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Pending Fees</Text>
            <Text className="text-2xl font-bold text-error">$24,100</Text>
          </View>
          <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Defaulters</Text>
            <Text className="text-2xl font-bold text-on-surface">45</Text>
          </View>
        </View>

        <Text className="text-lg font-bold text-on-surface mb-4">Quick Actions</Text>
        
        <View className="flex-row justify-between mb-8">
          {[
            { label: "Invoice", icon: "$" },
            { label: "Alerts", icon: "!" },
            { label: "Reports", icon: "📊" },
          ].map((action, index) => (
            <TouchableOpacity key={index} className="items-center bg-white border border-surface-container-highest flex-1 py-4 mx-1 rounded-xl shadow-sm">
              <View className="w-12 h-12 bg-surface-container-low rounded-full justify-center items-center mb-2">
                <Text className="text-primary font-bold text-xl">{action.icon}</Text>
              </View>
              <Text className="text-on-surface-variant text-xs font-medium">{action.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text className="text-lg font-bold text-on-surface mb-4">Recent Transactions</Text>
        <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-10">
          {[
            { id: "TXN-842", amount: "$1,200", status: "Success", date: "Today, 10:45 AM" },
            { id: "TXN-841", amount: "$850", status: "Success", date: "Today, 09:12 AM" },
            { id: "TXN-840", amount: "$2,400", status: "Failed", date: "Yesterday, 04:30 PM" },
          ].map((txn, index) => (
            <View key={index} className={`flex-row justify-between items-center py-3 ${index !== 2 ? 'border-b border-surface-container-low' : ''}`}>
              <View>
                <Text className="text-on-surface font-semibold">{txn.id}</Text>
                <Text className="text-on-surface-variant text-xs">{txn.date}</Text>
              </View>
              <View className="items-end">
                <Text className="text-on-surface font-bold mb-1">{txn.amount}</Text>
                <Text className={`text-xs font-bold ${txn.status === 'Success' ? 'text-green-600' : 'text-error'}`}>{txn.status}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
