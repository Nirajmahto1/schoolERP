import React, { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { authApi } from "../../lib/api";

// ──────────────────────────────────────────────
// Login — real gateway auth (Phase 9).
//
// White-label: the school's name rides in via app.config.ts extra.brand, so
// each branded build greets its own school with zero runtime config.
//
// One email/password form; the ROLE comes from the token's claims, not from
// which button the user tapped. The demo role-buttons remain as a dev
// shortcut only when login fails (removed in store builds).
// ──────────────────────────────────────────────
function roleFor(user: any): string {
  const roles: string[] = user?.roles ?? [];
  if (roles.includes('SUPER_ADMIN') || roles.includes('BRANCH_ADMIN') || roles.includes('PRINCIPAL')) return 'principal';
  if (roles.includes('TEACHER') || roles.includes('HOD') || roles.includes('ACADEMIC_HEAD')) return 'teacher';
  if (roles.includes('FINANCE') || roles.includes('ACCOUNTANT')) return 'finance';
  if (roles.includes('PARENT') || roles.includes('GUARDIAN')) return 'parent';
  if (roles.includes('STUDENT')) return 'parent'; // student portal uses the same child views
  return 'principal';
}

// School name injected at build time by the white-label config
// (apps/mobile/app.config.ts → extra.brand). Falls back neutrally in dev.
const BRAND = (Constants.expoConfig?.extra as { brand?: { schoolName?: string } } | undefined)?.brand;
const SCHOOL_NAME = BRAND?.schoolName ?? 'School ERP';

export default function LoginScreen({ onLogin }: { onLogin: (role: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const login = async () => {
    if (!email || !password) {
      Alert.alert('Missing details', 'Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      const res = await authApi.login(email.trim(), password);
      await AsyncStorage.setItem('erp_token', res.accessToken);
      await AsyncStorage.setItem('erp_refresh_token', res.refreshToken);
      onLogin(roleFor(res.user));
    } catch (e: any) {
      Alert.alert('Sign in failed', e?.detail || 'Check your email and password.');
    }
    setBusy(false);
  };

  return (
    <View className="flex-1 bg-surface justify-center px-6">
      <View className="items-center mb-10">
        <View className="w-16 h-16 bg-primary rounded-xl justify-center items-center mb-4">
          <Text className="text-white text-3xl font-bold">S</Text>
        </View>
        <Text className="text-3xl font-bold text-on-surface">Welcome Back</Text>
        <Text className="text-on-surface-variant mt-2 text-center">
          Sign in to {SCHOOL_NAME}
        </Text>
      </View>

      <View className="space-y-4">
        <View>
          <Text className="text-sm text-on-surface-variant mb-1 ml-1">Email or ID</Text>
          <TextInput
            className="w-full bg-white border border-surface-container-highest rounded-lg px-4 py-3 text-on-surface"
            placeholder="parent@school.edu"
            placeholderTextColor="#737686"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
        </View>

        <View className="mb-2">
          <Text className="text-sm text-on-surface-variant mb-1 ml-1">Password</Text>
          <TextInput
            className="w-full bg-white border border-surface-container-highest rounded-lg px-4 py-3 text-on-surface"
            placeholder="••••••••"
            placeholderTextColor="#737686"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
        </View>

        <TouchableOpacity
          className="w-full bg-primary rounded-lg py-4 items-center"
          onPress={login}
          disabled={busy}
        >
          {busy
            ? <ActivityIndicator color="#fff" />
            : <Text className="text-white font-semibold text-lg">Sign In</Text>}
        </TouchableOpacity>

        <Text className="text-on-surface-variant text-xs text-center mt-4">
          Parents: use the email your school registered.
        </Text>
      </View>
    </View>
  );
}
