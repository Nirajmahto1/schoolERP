import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TextInput, ActivityIndicator } from "react-native";
import { libraryApi } from "../../lib/api";

export default function LibraryScreen() {
  const [books, setBooks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadBooks();
  }, []);

  const loadBooks = (query?: string) => {
    setLoading(true);
    libraryApi.getBooks(query ? { search: query } : undefined).then(res => {
      setBooks(res.data || []);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  };

  return (
    <View className="flex-1 bg-surface">
      <View className="pt-16 pb-6 px-6 bg-surface-container-low rounded-b-3xl">
        <Text className="text-2xl font-bold text-on-surface mb-4">Library</Text>
        <TextInput
          className="w-full bg-white border border-surface-container-highest rounded-lg px-4 py-3 text-on-surface"
          placeholder="Search books by title or author..."
          placeholderTextColor="#737686"
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={() => loadBooks(search)}
        />
      </View>
      <ScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#004ac6" className="mt-10" />
        ) : books.length === 0 ? (
          <View className="items-center mt-16">
            <Text className="text-4xl mb-4">📚</Text>
            <Text className="text-on-surface-variant text-center">No books found. Try a different search.</Text>
          </View>
        ) : (
          books.map((book, i) => (
            <View key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-surface-container-highest mb-4 flex-row items-center">
              <View className="w-14 h-18 bg-primary/10 rounded-lg justify-center items-center mr-4 px-2 py-4">
                <Text className="text-primary font-bold text-lg">📖</Text>
              </View>
              <View className="flex-1">
                <Text className="text-on-surface font-semibold text-base">{book.title}</Text>
                <Text className="text-on-surface-variant text-sm mt-1">{book.author}</Text>
                <View className="flex-row mt-2 items-center">
                  <View className={`px-2 py-0.5 rounded-md ${book.available ? 'bg-primary/10' : 'bg-error/10'}`}>
                    <Text className={`text-xs font-medium ${book.available ? 'text-primary' : 'text-error'}`}>
                      {book.available ? 'Available' : 'Issued'}
                    </Text>
                  </View>
                  {book.category && (
                    <Text className="text-on-surface-variant text-xs ml-2">{book.category}</Text>
                  )}
                </View>
              </View>
            </View>
          ))
        )}
        <View className="h-10" />
      </ScrollView>
    </View>
  );
}
