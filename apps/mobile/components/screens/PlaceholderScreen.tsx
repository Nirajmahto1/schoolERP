import React from "react";
import { View, Text } from "react-native";

export default function PlaceholderScreen({ route }: any) {
  return (
    <View className="flex-1 bg-surface justify-center items-center">
      <View className="w-16 h-16 bg-primary/10 rounded-full justify-center items-center mb-4">
        <Text className="text-primary font-bold text-2xl">🚧</Text>
      </View>
      <Text className="text-2xl font-bold text-on-surface mb-2">{route.name}</Text>
      <Text className="text-on-surface-variant text-center px-10">
        This feature is currently under development.
      </Text>
    </View>
  );
}
