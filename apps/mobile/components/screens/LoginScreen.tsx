import React from "react";
import { View, Text, TextInput, TouchableOpacity } from "react-native";

export default function LoginScreen({ onLogin }: { onLogin: (role: string) => void }) {
  return (
    <View className="flex-1 bg-surface justify-center px-6">
      <View className="items-center mb-10">
        <View className="w-16 h-16 bg-primary rounded-xl justify-center items-center mb-4">
          <Text className="text-white text-3xl font-bold">S</Text>
        </View>
        <Text className="text-3xl font-bold text-on-surface">Welcome Back</Text>
        <Text className="text-on-surface-variant mt-2 text-center">
          Sign in to the School ERP
        </Text>
      </View>

      <View className="space-y-4">
        <View>
          <Text className="text-sm text-on-surface-variant mb-1 ml-1">Email or ID</Text>
          <TextInput
            className="w-full bg-white border border-surface-container-highest rounded-lg px-4 py-3 text-on-surface"
            placeholder="admin@school.edu"
            placeholderTextColor="#737686"
          />
        </View>

        <View className="mb-2">
          <Text className="text-sm text-on-surface-variant mb-1 ml-1">Password</Text>
          <TextInput
            className="w-full bg-white border border-surface-container-highest rounded-lg px-4 py-3 text-on-surface"
            placeholder="••••••••"
            placeholderTextColor="#737686"
            secureTextEntry
          />
        </View>

        <TouchableOpacity className="self-end mb-6">
          <Text className="text-primary font-medium">Forgot Password?</Text>
        </TouchableOpacity>

        <TouchableOpacity
          className="w-full bg-primary rounded-lg py-4 items-center"
          onPress={() => onLogin("principal")}
        >
          <Text className="text-white font-semibold text-lg">Login as Principal</Text>
        </TouchableOpacity>
        
        <View className="flex-row justify-between mt-4">
          <TouchableOpacity
            className="flex-1 bg-surface-container-highest rounded-lg py-3 items-center mr-2"
            onPress={() => onLogin("teacher")}
          >
            <Text className="text-on-surface font-medium">Teacher</Text>
          </TouchableOpacity>
          <TouchableOpacity
            className="flex-1 bg-surface-container-highest rounded-lg py-3 items-center mx-2"
            onPress={() => onLogin("finance")}
          >
            <Text className="text-on-surface font-medium">Finance</Text>
          </TouchableOpacity>
          <TouchableOpacity
            className="flex-1 bg-surface-container-highest rounded-lg py-3 items-center ml-2"
            onPress={() => onLogin("parent")}
          >
            <Text className="text-on-surface font-medium">Parent</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
