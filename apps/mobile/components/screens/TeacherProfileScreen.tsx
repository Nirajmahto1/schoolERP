import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator, TouchableOpacity } from "react-native";
import { teacherApi } from "../../lib/api";

export default function TeacherProfileScreen() {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    teacherApi.getProfile().then(res => {
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
            {profile?.firstName?.[0] || 'T'}{profile?.lastName?.[0] || ''}
          </Text>
        </View>
        <Text className="text-2xl font-bold text-on-surface">
          {profile?.firstName} {profile?.lastName}
        </Text>
        <Text className="text-on-surface-variant text-sm mt-1">{profile?.department || 'Teacher'}</Text>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-4">
          <Text className="text-on-surface-variant text-xs mb-1">Email</Text>
          <Text className="text-on-surface font-medium">{profile?.email || 'N/A'}</Text>
        </View>
        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-4">
          <Text className="text-on-surface-variant text-xs mb-1">Phone</Text>
          <Text className="text-on-surface font-medium">{profile?.phone || 'N/A'}</Text>
        </View>
        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-4">
          <Text className="text-on-surface-variant text-xs mb-1">Employee ID</Text>
          <Text className="text-on-surface font-medium">{profile?.employeeId || 'N/A'}</Text>
        </View>
        <View className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-6">
          <Text className="text-on-surface-variant text-xs mb-1">Joining Date</Text>
          <Text className="text-on-surface font-medium">{profile?.joiningDate || 'N/A'}</Text>
        </View>

        <TouchableOpacity className="w-full bg-primary rounded-xl py-4 items-center mb-4 shadow-sm">
          <Text className="text-white font-semibold text-lg">Edit Profile</Text>
        </TouchableOpacity>
        <TouchableOpacity className="w-full bg-error/10 rounded-xl py-4 items-center mb-10">
          <Text className="text-error font-semibold text-lg">Logout</Text>
        </TouchableOpacity>
        <View className="h-10" />
      </ScrollView>
    </View>
  );
}
