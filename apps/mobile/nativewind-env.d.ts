// NativeWind's JSX augmentation: teaches React Native's core components
// (View, Text, TouchableOpacity, …) about the `className` prop. Without this
// reference, every styled component in the app is a TS2769/TS2322 — hundreds
// of pre-existing errors of a single class, drowning real signal.
/// <reference types="nativewind/types" />
