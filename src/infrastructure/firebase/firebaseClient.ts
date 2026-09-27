import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";

// 1. あなたの環境変数（Config）をここに復活させます
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
export const functions = getFunctions(app, 'asia-northeast1');

// 3. エミュレータ接続設定
if (typeof window !== 'undefined' && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
  console.log("🛠️ Admin App connecting to Emulators...");
  connectFirestoreEmulator(dbInstance, '127.0.0.1', 8080);
  connectAuthEmulator(auth, "http://127.0.0.1:9099");
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}

export const db = dbInstance;