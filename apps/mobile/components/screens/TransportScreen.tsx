import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { transportApi } from "../../lib/api";

export default function TransportScreen() {
  const [routes, setRoutes] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      transportApi.getRoutes(),
      transportApi.getVehicles(),
    ]).then(([routesRes, vehiclesRes]) => {
      setRoutes(routesRes.data || []);
      setVehicles(vehiclesRes.data || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-6">Transport</Text>
        <View className="flex-row justify-between">
          <View className="bg-white flex-1 rounded-2xl p-4 mr-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Routes</Text>
            <Text className="text-2xl font-bold text-primary">{routes.length}</Text>
          </View>
          <View className="bg-white flex-1 rounded-2xl p-4 ml-2 shadow-sm border border-surface-container-highest">
            <Text className="text-on-surface-variant text-xs mb-1">Vehicles</Text>
            <Text className="text-2xl font-bold text-primary">{vehicles.length}</Text>
          </View>
        </View>
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#004ac6" className="mt-10" />
        ) : (
          <>
            <Text className="text-lg font-bold text-on-surface mb-4">Routes</Text>
            {routes.map((route, i) => (
              <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4 flex-row items-center">
                <View className="w-12 h-12 bg-primary/10 rounded-full justify-center items-center mr-4">
                  <Text className="text-xl">🚌</Text>
                </View>
                <View className="flex-1">
                  <Text className="text-on-surface font-semibold text-base">{route.name}</Text>
                  <Text className="text-on-surface-variant text-sm mt-1">{route.stops?.length || 0} stops</Text>
                </View>
              </View>
            ))}

            <Text className="text-lg font-bold text-on-surface mb-4 mt-4">Vehicles</Text>
            {vehicles.map((v, i) => (
              <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4 flex-row items-center">
                <View className="w-12 h-12 bg-surface-container-low rounded-full justify-center items-center mr-4">
                  <Text className="text-xl">🚐</Text>
                </View>
                <View className="flex-1">
                  <Text className="text-on-surface font-semibold">{v.registrationNumber || v.name}</Text>
                  <Text className="text-on-surface-variant text-sm mt-1">Capacity: {v.capacity || 'N/A'}</Text>
                </View>
                <View className={`px-2 py-1 rounded-md ${v.active ? 'bg-primary/10' : 'bg-surface-container-low'}`}>
                  <Text className={`text-xs font-medium ${v.active ? 'text-primary' : 'text-on-surface-variant'}`}>
                    {v.active ? 'Active' : 'Inactive'}
                  </Text>
                </View>
              </View>
            ))}
          </>
        )}
        <View className="h-10" />
      </ScrollView>
    </View>
  );
}
