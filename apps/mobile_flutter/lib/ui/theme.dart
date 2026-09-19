// ──────────────────────────────────────────────
// Theme — one Material 3 theme for every role shell.
// ──────────────────────────────────────────────

import 'package:flutter/material.dart';

class AppTheme {
  static const seed = Color(0xFF1E5AA8); // school blue

  static ThemeData light() {
    final base = ThemeData(useMaterial3: true, colorSchemeSeed: seed, brightness: Brightness.light);
    return base.copyWith(
      appBarTheme: const AppBarTheme(centerTitle: false, elevation: 0),
      inputDecorationTheme: InputDecorationTheme(
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        filled: true,
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: Colors.grey.shade300),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
      ),
    );
  }

  static ThemeData dark() {
    final base = ThemeData(useMaterial3: true, colorSchemeSeed: seed, brightness: Brightness.dark);
    return base.copyWith(
      appBarTheme: const AppBarTheme(centerTitle: false, elevation: 0),
      inputDecorationTheme: InputDecorationTheme(
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        filled: true,
      ),
    );
  }
}
