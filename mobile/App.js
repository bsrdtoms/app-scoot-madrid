import { registerRootComponent } from 'expo';
import React, { useEffect, useRef, useState } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SERVER_URL = 'http://localhost:3000';

export default function App() {
  const [locInjected, setLocInjected] = useState(false);
  const webRef = useRef(null);

  // Géoloc → injectée dans la WebView une fois chargée
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setLocInjected(true);
      // Injecter la position dans la page Leaflet
      webRef.current?.injectJavaScript(`
        if (window._map) {
          window._map.setView([${loc.coords.latitude}, ${loc.coords.longitude}], 15);
        }
        true;
      `);
    })();
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.title}>🛵 ScootMap</Text>
      </View>
      <WebView
        ref={webRef}
        style={styles.webview}
        source={{ uri: SERVER_URL }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        geolocationEnabled
        allowsInlineMediaPlayback
        onError={(e) => console.warn('WebView error:', e.nativeEvent)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: {
    paddingTop: Platform.OS === 'ios' ? 54 : 36,
    paddingBottom: 10,
    paddingHorizontal: 16,
    backgroundColor: '#0f172a',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#f8fafc' },
  webview: { flex: 1 },
});

registerRootComponent(App);
