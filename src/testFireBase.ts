import { db } from "./firebase";
import { FastPeerConnection, type SignalServer } from "./netaware";
import { ref, onValue, child, remove, set, push } from "firebase/database";

//TODO make it so the call reconnects.
export type CallUIHooks = {
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (peerUserId: string, stream: MediaStream) => void;
  onPeerLeft: (peerUserId: string) => void;
  onStatusChange: (status: "connecting" | "connected" | "disconnected") => void;
};

//get info from URL
const params = new URLSearchParams(window.location.search);
const roomId = params.get("code")!;
const userRank = params.get("rank")!;

const connections = new Map<string, FastPeerConnection>();

let uiHooks: CallUIHooks | null = null;
let localStream: MediaStream | null = null;

window.onload = async () => {
  console.log("page loaded");
};

window.addEventListener("beforeunload", async () => {
  await remove(user_path(userRank));
  for (const peerUserId of connections.keys()) {
    const connectionRef = ref(
      db,
      `rooms/${roomId}/connections/${make_connection_id(userRank, peerUserId)}`,
    );
    await remove(connectionRef);
  }
});

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

/**
 * @param a connection rank of the first user
 * @param b connection rank of the second user
 * @returns the connection ID to where the connection prosses is stored in the db.
 */
const make_connection_id = (a: string, b: string) => [a, b].sort().join("_");

const firebase_presence = async () => {
  const myUserRef = user_path(userRank);
  await set(myUserRef, { userRank });
};

const host_with_firebase = async (
  roomId: string,
  connectionId: string,
  connection: FastPeerConnection,
) => {
  const roomRef = ref(db, `rooms/${roomId}/connections/${connectionId}`);

  connection.on_ice_candidate((candidate) => {
    push(child(roomRef, "offerCandidates"), candidate.toJSON());
  });

  const offer = await connection.create_offer();
  await set(child(roomRef, "offer"), {
    sdp: offer.sdp,
    type: offer.type,
  });

  onValue(child(roomRef, "answer"), async (snapshot) => {
    const answer = snapshot.val();
    await connection.setRemoteDescription(answer);
  });

  onValue(child(roomRef, "answerCandidates"), (snapshot) => {
    snapshot.forEach((candidate) => {
      connection.add_ice_candidate(new RTCIceCandidate(candidate.val()));
    });
  });
};

const join_with_firebase = (
  roomId: string,
  connectionId: string,
  connection: FastPeerConnection,
) => {
  const roomRef = ref(db, `rooms/${roomId}/connections/${connectionId}`);

  connection.on_ice_candidate((candidate) => {
    push(child(roomRef, "answerCandidates"), candidate.toJSON());
  });

  onValue(child(roomRef, "offer"), async (snapshot) => {
    const offer = snapshot.val();

    if (offer) {
      await connection.setRemoteDescription(offer);

      const answer = await connection.create_answer();

      await set(child(roomRef, "answer"), {
        sdp: answer.sdp,
        type: answer.type,
      });
    }
  });

  onValue(child(roomRef, "offerCandidates"), (snapshot) => {
    snapshot.forEach((candidate) => {
      connection.add_ice_candidate(new RTCIceCandidate(candidate.val()));
    });
  });
};

const create_connection = async (peerUserId: string) => {
  console.log(`Creating connection with peer ${peerUserId}`);
  //const peerUserRef = user_path(peerUserId);

  const peerUserRank: number = Number(peerUserId); // rn Rank and ID are the same, might change later

  const signal_server: SignalServer = {
    makes_first_move: Number(userRank) < peerUserRank,
    send_signal_state: async (state: string) => {
      await set(child(user_path(peerUserId), "signal_state"), state);
    },
    error_handler: async () => {
      console.error("Fatal error occurred");
      uiHooks?.onStatusChange("disconnected");
    },
  };

  const connection = new FastPeerConnection(signal_server, 1000);
  connections.set(peerUserId, connection);

  await connection.addMediaStream({ video: true, audio: true }, (stream) => {
    uiHooks?.onRemoteStream(peerUserId, stream);
  });

  uiHooks?.onStatusChange("connecting");

  const connectionId = make_connection_id(userRank, peerUserId);

  if (signal_server.makes_first_move) {
    host_with_firebase(roomId!, connectionId, connection);
  } else {
    join_with_firebase(roomId!, connectionId, connection);
  }

  connection.reconnect(() => {
    console.log("Reconnection attempt finished.");
  });

  connection.onDisconnect(() => {
    console.log(`Connection with peer ${peerUserId} disconnected.`);
    uiHooks?.onStatusChange("disconnected");
    handle_peer_left(peerUserId);
  });

  console.log("Waiting for connection to be ready...");
  await connection.on_ready();

  uiHooks?.onStatusChange("connected");
};

const handle_peer_left = (peerUserId: string) => {
  console.log(`Peer ${peerUserId} has left the call`);
  connections.delete(peerUserId);
  uiHooks?.onPeerLeft(peerUserId);
};

export const register_ui_hooks = (hooks: CallUIHooks) => {
  uiHooks = hooks;
};

export const begin_connection = async () => {
  console.log("beginning connection");
  await get_local_preview_stream();
  await firebase_presence();

  // right now the user ID is just the rank, might change to something else later.
  const myUserIdStr = userRank;
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
        create_connection(peerUserId);
      }
    });
  });

  // Remove peers when they leave
  onValue(usersRef, (snapshot) => {
    const currentPeers = new Set<string>();
    snapshot.forEach((user) => {
      currentPeers.add(user.key);
    });
    connections.forEach((_conn, peerUserId) => {
      if (!currentPeers.has(peerUserId)) {
        handle_peer_left(peerUserId);
      }
    });
  });
};

// TODO: add functinality to toggle mic
export const toggle_mic = (enabled: boolean) => {
  localStream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
};

// TODO: add functionality to toggle camera
export const toggle_camera = (enabled: boolean) => {
  localStream?.getVideoTracks().forEach((track) => {
    track.enabled = enabled;
  });
};

// TODO: add functinality to share screen
export const share_screen = () => {
  connections.forEach((conn) => conn.share_screen());
};

export const leave_call = async () => {
  localStream?.getTracks().forEach((track) => track.stop());
  connections.clear();
};
