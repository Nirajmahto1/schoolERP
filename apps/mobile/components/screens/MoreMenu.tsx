import React from "react";
import { View, Text, ScrollView, TouchableOpacity } from "react-native";

interface MenuItem {
  label: string;
  icon: string;
  route: string;
  description: string;
}

interface MoreMenuProps {
  title: string;
  items: MenuItem[];
  navigation: any;
}

export default function MoreMenu({ title, items, navigation }: MoreMenuProps) {
  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface">{title}</Text>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {items.map((item, i) => (
          <TouchableOpacity
            key={i}
            onPress={() => navigation.navigate(item.route)}
            className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4 flex-row items-center"
            activeOpacity={0.7}
          >
            <View className="w-12 h-12 bg-primary/10 rounded-full justify-center items-center mr-4">
              <Text className="text-xl">{item.icon}</Text>
            </View>
            <View className="flex-1">
              <Text className="text-on-surface font-semibold text-base">{item.label}</Text>
              <Text className="text-on-surface-variant text-sm mt-0.5">{item.description}</Text>
            </View>
            <Text className="text-on-surface-variant text-lg">›</Text>
          </TouchableOpacity>
        ))}
        <View className="h-10" />
      </ScrollView>
    </View>
  );
}
