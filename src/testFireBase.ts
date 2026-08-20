import { db } from "./firebase";
import { FastPeerConnection, type SignalServer } from "./netaware";
import {
  ref,
  onValue,
  onChildRemoved,
  child,
  get,
  onDisconnect,
  remove,
  set,
  runTransaction,
} from "firebase/database";

const params = new URLSearchParams(window.location.search);
const roomId = params.get("code");

const roomRef = ref(db, `rooms/${roomId}`);

let userRankValue: number | null = null;
const userRankPromise: Promise<number> = runTransaction(
  child(roomRef, "userCount"),
  (count) => (count || 0) + 1,
).then((result) => {
  if (!result.committed) {
    throw new Error("Failed to claim a userRank (transaction aborted).");
  }
  const rank: number = result.snapshot.val();
  userRankValue = rank;
  return rank;
});

const connections = new Map<string, FastPeerConnection>();

export type CallUIHooks = {
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (peerUserId: string, stream: MediaStream) => void;
  onPeerLeft: (peerUserId: string) => void;
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

const user_path = (userId: string | number) =>
  ref(db, `rooms/${roomId}/users/${userId}`);

const join_room_presence = async (myUserRank: number) => {
  const myUserRef = user_path(myUserRank);
  const connectionRank = myUserRank;
  await set(myUserRef, { connectionRank });
  onDisconnect(myUserRef).remove();
};

const make_connection_id = (a: string, b: string) => [a, b].sort().join("_");

const create_connection = async (peerUserId: string, myUserRank: number) => {
  const peerUserRef = user_path(peerUserId);
  const myUserRef = user_path(myUserRank);

  const [peerRankSnapshot, myRankSnapshot] = await Promise.all([
    get(child(peerUserRef, "connectionRank")).then((s) => s.val()),
    get(child(myUserRef, "connectionRank")).then((s) => s.val()),
  ]);

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

  const connectionId = make_connection_id(String(myUserRank), peerUserId);

  if (signal_server.makes_first_move) {
    conn.host_with_firebase(roomId!, connectionId);
  } else {
    conn.join_with_firebase(roomId!, connectionId);
  }

  await conn.on_ready();
  uiHooks?.onStatusChange("connected");
};

const handle_peer_left = (peerUserId: string) => {
  connections.delete(peerUserId);
  uiHooks?.onPeerLeft(peerUserId);
};

export const begin_connection = async () => {
  const myUserRank = await userRankPromise;

  await get_local_preview_stream();
  await join_room_presence(myUserRank);

  const myUserIdStr = String(myUserRank);
  const usersRef = ref(db, `rooms/${roomId}/users`);

  // Watch for peers to join
  onValue(usersRef, (snapshot) => {
    snapshot.forEach((user) => {
      const peerUserId = user.key;
      if (
        peerUserId &&
        peerUserId !== myUserIdStr &&
        !connections.has(peerUserId)
      ) {
        create_connection(peerUserId, myUserRank);
      }
    });
  });

  // Watch for peers to leave
  onChildRemoved(usersRef, (snapshot) => {
    const peerUserId = snapshot.key;
    if (peerUserId && peerUserId !== myUserIdStr) {
      handle_peer_left(peerUserId);
    }
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
  if (userRankValue !== null) {
    await remove(user_path(userRankValue));
  }
  localStream?.getTracks().forEach((track) => track.stop());
  connections.clear();
};
