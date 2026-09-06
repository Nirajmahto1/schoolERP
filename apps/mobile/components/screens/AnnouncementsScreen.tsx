import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator, TouchableOpacity } from "react-native";
import { communicationApi } from "../../lib/api";

export default function AnnouncementsScreen() {
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    communicationApi.getAnnouncements().then(res => {
      setAnnouncements(res.data || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  const getTypeColor = (type: string) => {
    switch (type?.toLowerCase()) {
      case 'urgent': return { bg: 'bg-error/10', text: 'text-error' };
      case 'event': return { bg: 'bg-primary/10', text: 'text-primary' };
      default: return { bg: 'bg-surface-container-low', text: 'text-on-surface-variant' };
    }
  };

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface">Announcements</Text>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#004ac6" className="mt-10" />
        ) : announcements.length === 0 ? (
          <View className="items-center mt-16">
            <Text className="text-4xl mb-4">📢</Text>
            <Text className="text-on-surface-variant text-center">No announcements yet.</Text>
          </View>
        ) : (
          announcements.map((a, i) => {
            const colors = getTypeColor(a.type);
            return (
              <View key={i} className="bg-white rounded-2xl p-5 shadow-sm border border-surface-container-highest mb-4">
                <View className="flex-row items-center justify-between mb-2">
                  <View className={`px-2 py-0.5 rounded-md ${colors.bg}`}>
                    <Text className={`text-xs font-medium ${colors.text}`}>{a.type || 'General'}</Text>
                  </View>
                  <Text className="text-on-surface-variant text-xs">{a.createdAt ? new Date(a.createdAt).toLocaleDateString() : ''}</Text>
                </View>
                <Text className="text-on-surface font-bold text-lg mb-1">{a.title}</Text>
                <Text className="text-on-surface-variant text-sm leading-5">{a.content}</Text>
                {a.targetRoles && (
                  <View className="flex-row mt-3 flex-wrap">
                    {a.targetRoles.map((role: string, ri: number) => (
                      <View key={ri} className="bg-surface-container-low px-2 py-0.5 rounded-md mr-2 mb-1">
                        <Text className="text-on-surface-variant text-xs">{role}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })
        )}
        <View className="h-10" />
      </ScrollView>
    </View>
  );
}
