import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyCiI_KVMESXRv5TjH8zxMuiMGUbijN0BSM",
  authDomain: "webrtc-7eb8b.firebaseapp.com",
  databaseURL: "https://webrtc-7eb8b-default-rtdb.firebaseio.com",
  projectId: "webrtc-7eb8b",
  storageBucket: "webrtc-7eb8b.firebasestorage.app",
  messagingSenderId: "228666281349",
  appId: "1:228666281349:web:3a606d8f1f75b00fb608ec",
  measurementId: "G-VHMB815B2Q",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
