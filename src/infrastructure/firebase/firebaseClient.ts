import { initializeApp } from "firebase/app";
import "firebase/auth";
import "firebase/firestore";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";

// 1. 環境変数（Config: Vite / Node.js 両対応）
const env = (typeof import.meta !== 'undefined' && import.meta.env)
  ? import.meta.env
  : ((typeof process !== 'undefined' && process.env) ? process.env : {} as Record<string, string | undefined>);

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || "demo-key",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || "demo-no-project.firebaseapp.com",
  projectId: env.VITE_FIREBASE_PROJECT_ID || "demo-no-project",
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || "demo-no-project.appspot.com",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || "123456789",
  appId: env.VITE_FIREBASE_APP_ID || "1:123456789:web:abcdef",
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID || "G-ABCDEF",
};

// 2. 初期化
const app = initializeApp(firebaseConfig);

// 3. ローカル判定
const isLocal = (typeof window !== 'undefined' && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"))
  || (typeof process !== 'undefined' && (process.env.FIRESTORE_EMULATOR_HOST || process.env.NODE_ENV === 'test' || process.env.ENABLE_EMULATOR === 'true'));

export const isFirebaseMisconfigured = !isLocal && (firebaseConfig.apiKey === "demo-key" || firebaseConfig.projectId === "demo-no-project");

// 4. Auth初期化（Firestoreより先に初期化してコンポーネント未登録を防ぐ）
let authInstance: Auth = { currentUser: null } as unknown as Auth;
if (typeof window !== 'undefined') {
  authInstance = getAuth(app);
  if (isLocal) {
    try {
      connectAuthEmulator(authInstance, "http://127.0.0.1:9099");
    } catch {
      // already connected
    }
  }
}

// 5. Firestore初期化
const dbInstance = getFirestore(app);
if (isLocal) {
  try {
    connectFirestoreEmulator(dbInstance, '127.0.0.1', 8080);
  } catch {
    // already connected
  }
}

export const auth = authInstance;

export const db = dbInstance;
