import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { studentApi } from "../../lib/api";

export default function ParentChildResults() {
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    studentApi.getMyResults().then(res => {
      setResults(res || {});
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-6">Report Card</Text>
        <View className="bg-primary-container rounded-2xl p-5 shadow-sm">
          <Text className="text-white/80 text-sm mb-1">Term 1 Finals</Text>
          <View className="flex-row items-end justify-between">
            <Text className="text-4xl font-bold text-white">92.5%</Text>
            <Text className="text-xl font-bold text-white mb-1">A+</Text>
          </View>
        </View>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator size="large" color="#004ac6" /> : 
          <View className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-10">
            <Text className="text-lg font-bold text-on-surface mb-4">Subject Wise</Text>
            {[
              { subject: "Mathematics", marks: "95/100", grade: "A+" },
              { subject: "Science", marks: "88/100", grade: "A" },
              { subject: "History", marks: "91/100", grade: "A" },
            ].map((sub, i) => (
              <View key={i} className={`flex-row justify-between items-center py-3 ${i !== 2 ? 'border-b border-surface-container-low' : ''}`}>
                <Text className="text-on-surface font-semibold flex-1">{sub.subject}</Text>
                <Text className="text-on-surface-variant mr-4">{sub.marks}</Text>
                <View className="bg-surface-container-low px-2 py-1 rounded-md min-w-[30px] items-center">
                   <Text className="text-primary font-bold text-sm">{sub.grade}</Text>
                </View>
              </View>
            ))}
          </View>
        }
      </ScrollView>
    </View>
  );
}
