import { db } from "./firebase";
import { FastPeerConnection, type SignalServer } from "./netaware";
import {
  ref,
  onValue,
  child,
  get,
  onDisconnect,
  remove,
  set,
} from "firebase/database";

const params = new URLSearchParams(window.location.search);
const roomId = params.get("code");
const userId = params.get("user");

if (!roomId || !userId) {
  throw new Error(
    "Missing room code or user id in the URL (?code=...&user=...)",
  );
}

const connections = new Map<string, FastPeerConnection>();

export type CallUIHooks = {
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (peerUserId: string, stream: MediaStream) => void;
  onStatusChange: (status: "connecting" | "connected" | "disconnected") => void;
};

let uiHooks: CallUIHooks | null = null;
let localStream: MediaStream | null = null;

export const register_ui_hooks = (hooks: CallUIHooks) => {
  uiHooks = hooks;
};

const get_local_preview_stream = async (): Promise<MediaStream> => {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });
  uiHooks?.onLocalStream(localStream);
  return localStream;
};

const join_room_presence = async () => {
  const myUserRef = ref(db, `rooms/${roomId}/users/${userId}`);
  const connectionRank = Math.random();
  await set(myUserRef, { connectionRank });
  onDisconnect(myUserRef).remove();
};

const create_video_tile = (stream: MediaStream): HTMLDivElement => {
  const container = document.createElement("div");
  const video = document.createElement("video");
  video.srcObject = stream;
  video.play();
  container.appendChild(video);
  return container;
};

const create_connection = async (peerUserId: string) => {
  const peerUserRef = ref(db, `rooms/${roomId}/users/${peerUserId}`);
  const myUserRef = ref(db, `rooms/${roomId}/users/${userId}`);

  const peerRankSnapshot = (
    await get(child(peerUserRef, "connectionRank"))
  ).val();
  const myRankSnapshot = (await get(child(myUserRef, "connectionRank"))).val();

  const signal_server: SignalServer = {
    makes_first_move: myRankSnapshot < peerRankSnapshot,
    send_signal_state: async (state: string) => {
      console.log("Sending signal state:", state);
    },
    error_handler: async () => {
      console.error("Fatal error occurred");
      uiHooks?.onStatusChange("disconnected");
    },
  };

  const conn = new FastPeerConnection(signal_server, 1000);
  connections.set(peerUserId, conn);

  await conn.addMediaStream({ video: true, audio: true }, (stream) => {
    uiHooks?.onRemoteStream(peerUserId, stream);
  });

  uiHooks?.onStatusChange("connecting");

  const connectionId = make_connection_id(userId!, peerUserId);

  if (signal_server.makes_first_move) {
    conn.host_with_firebase(roomId!, connectionId);
  } else {
    conn.join_with_firebase(roomId!, connectionId);
  }

  await conn.on_ready();
  uiHooks?.onStatusChange("connected");
};

const make_connection_id = (a: string, b: string) => [a, b].sort().join("_");

export const begin_connection = async () => {
  await get_local_preview_stream();
  await join_room_presence();

  const usersRef = ref(db, `rooms/${roomId}/users`);
  const userSnapshot = await get(usersRef);
  const tasks: Promise<void>[] = [];
  userSnapshot.forEach((user) => {
    const peerUserId = user.key;
    if (peerUserId && peerUserId !== userId) {
      tasks.push(create_connection(peerUserId));
    }
  });
  await Promise.all(tasks);

  // Watch for peers who join after us (e.g. we're the host, they join late).
  onValue(usersRef, (snapshot) => {
    snapshot.forEach((user) => {
      const peerUserId = user.key;
      if (peerUserId && peerUserId !== userId && !connections.has(peerUserId)) {
        create_connection(peerUserId);
      }
    });
  });
};

export const toggle_mic = (enabled: boolean) => {
  localStream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
};

export const toggle_camera = (enabled: boolean) => {
  localStream?.getVideoTracks().forEach((track) => {
    track.enabled = enabled;
  });
};

export const share_screen = () => {
  connections.forEach((conn) => conn.share_screen());
};

export const leave_call = async () => {
  await remove(ref(db, `rooms/${roomId}/users/${userId}`));
  localStream?.getTracks().forEach((track) => track.stop());
  connections.clear();
};
