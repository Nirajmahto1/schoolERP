import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { studentApi } from "../../lib/api";

export default function StudentProfileScreen() {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    studentApi.getProfile().then(res => {
      setProfile(res);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <View className="flex-1 bg-surface justify-center items-center">
        <ActivityIndicator size="large" color="#004ac6" />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-8 px-6 bg-surface-container-low rounded-b-3xl items-center">
        <View className="w-24 h-24 bg-primary/20 rounded-full justify-center items-center mb-4">
          <Text className="text-primary font-bold text-3xl">
            {profile?.firstName?.[0] || 'S'}{profile?.lastName?.[0] || ''}
          </Text>
        </View>
        <Text className="text-2xl font-bold text-on-surface">
          {profile?.firstName} {profile?.lastName}
        </Text>
        <Text className="text-on-surface-variant text-sm mt-1">
          {profile?.className} - {profile?.sectionName}
        </Text>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-4">
          <Text className="text-on-surface-variant text-xs mb-1">Admission No.</Text>
          <Text className="text-on-surface font-medium">{profile?.admissionNumber || 'N/A'}</Text>
        </View>
        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-4">
          <Text className="text-on-surface-variant text-xs mb-1">Date of Birth</Text>
          <Text className="text-on-surface font-medium">{profile?.dateOfBirth || 'N/A'}</Text>
        </View>
        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-4">
          <Text className="text-on-surface-variant text-xs mb-1">Parent / Guardian</Text>
          <Text className="text-on-surface font-medium">{profile?.parentName || 'N/A'}</Text>
        </View>
        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-4">
          <Text className="text-on-surface-variant text-xs mb-1">Contact</Text>
          <Text className="text-on-surface font-medium">{profile?.phone || 'N/A'}</Text>
        </View>
        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-4">
          <Text className="text-on-surface-variant text-xs mb-1">Blood Group</Text>
          <Text className="text-on-surface font-medium">{profile?.bloodGroup || 'N/A'}</Text>
        </View>
        <View className="h-10" />
      </ScrollView>
    </View>
  );
}
