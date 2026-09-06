import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TextInput, ActivityIndicator, TouchableOpacity } from "react-native";
import { feeApi } from "../../lib/api";

export default function FinanceInvoices() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    feeApi.getInvoices().then(res => {
      setInvoices(res.data || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-4">Invoices</Text>
        <TextInput
          className="w-full bg-white border border-surface-container-highest rounded-lg px-4 py-3 text-on-surface"
          placeholder="Search by student name or ID..."
          placeholderTextColor="#737686"
        />
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <TouchableOpacity className="w-full bg-primary rounded-lg py-4 items-center mb-6 shadow-sm">
          <Text className="text-white font-semibold text-lg">Generate Invoice</Text>
        </TouchableOpacity>

        {loading ? <ActivityIndicator size="large" color="#004ac6" /> : 
          invoices.map((inv, i) => (
            <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4">
              <View className="flex-row justify-between mb-2">
                <Text className="text-on-surface font-bold text-lg">{inv.studentName || 'Student Name'}</Text>
                <Text className="text-on-surface font-bold">${inv.amount}</Text>
              </View>
              <View className="flex-row justify-between items-center">
                <Text className="text-on-surface-variant text-sm">Due: {inv.dueDate}</Text>
                <View className={`px-2 py-1 rounded-md ${inv.status === 'PAID' ? 'bg-primary/20' : 'bg-error/20'}`}>
                  <Text className={`font-bold text-xs ${inv.status === 'PAID' ? 'text-primary' : 'text-error'}`}>{inv.status}</Text>
                </View>
              </View>
            </View>
          ))
        }
      </ScrollView>
    </View>
  );
}
