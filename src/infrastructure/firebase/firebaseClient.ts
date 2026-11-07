import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getAuth, connectAuthEmulator } from "firebase/auth";

// 1. 環境変数（Config）
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// 2. 初期化
const app = initializeApp(firebaseConfig);
const dbInstance = getFirestore(app);
export const auth = getAuth(app);

// 3. エミュレータ接続設定（ローカル開発用: Sparkプラン対応）
if (typeof window !== 'undefined' && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
  console.log("🛠️ App connecting to Emulators (Firestore & Auth)...");
  connectFirestoreEmulator(dbInstance, '127.0.0.1', 8080);
  connectAuthEmulator(auth, "http://127.0.0.1:9099");
}

export const db = dbInstance;