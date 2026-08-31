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
  push,
} from "firebase/database";

export type CallUIHooks = {
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (peerUserId: string, stream: MediaStream) => void;
  onPeerLeft: (peerUserId: string) => void;
  onStatusChange: (status: "connecting" | "connected" | "disconnected") => void;
};

// TODO: make desconnects trigger from FastPeerConnection state change instead of being triggered by firebase

//get info from URL
const params = new URLSearchParams(window.location.search);
const roomId = params.get("code");
const userRank = params.get("rank")!; // this should never be null

const connections = new Map<string, FastPeerConnection>();

let uiHooks: CallUIHooks | null = null;
let localStream: MediaStream | null = null;

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

// TODO: change room presence to setup firebase
const presence = async () => {
  const myUserRef = user_path(userRank);
  const connectionRank = userRank;
  await set(myUserRef, { connectionRank });

  // TODO: Make one disconnect be
  onDisconnect(myUserRef).remove();
};

const host_with_firebase = async (
  roomId: string,
  connectionId: string,
  connection: FastPeerConnection,
) => {
  const roomRef = ref(db, `rooms/${roomId}/connections/${connectionId}`);

  connection.on_ice_candidate((candidate) => {
      push(child(roomRef, "offerCandidates"), candidate.toJSON());

  })

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
    await connection.setRemoteDescription(offer);

    const answer = await connection.create_answer();
    await set(child(roomRef, "answer"), {
      sdp: answer.sdp,
      type: answer.type,
    });
  });

  onValue(child(roomRef, "offerCandidates"), (snapshot) => {
    snapshot.forEach((candidate) => {
      connection.add_ice_candidate(new RTCIceCandidate(candidate.val()));
    });
  });
};

const create_connection = async (peerUserId: string) => {
  const peerUserRef = user_path(peerUserId);

  const peerRankSnapshot = await get(child(peerUserRef, "connectionRank")).then(
    (s) => s.val(),
  );

  const signal_server: SignalServer = {
    makes_first_move: userRank < peerRankSnapshot,
    send_signal_state: async (state: string) => {
      console.log("Sending signal state:", state);
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

  await connection.on_ready();
  uiHooks?.onStatusChange("connected");
};

// TODO: make this clean up left over connection and remove the connection form the db.
const handle_peer_left = (peerUserId: string) => {
  connections.delete(peerUserId);
  uiHooks?.onPeerLeft(peerUserId);
};

export const register_ui_hooks = (hooks: CallUIHooks) => {
  uiHooks = hooks;
};

//TODO remove the onChildRemoved. Make clean up happen on rtc connection disconnect.  
export const begin_connection = async () => {
  await get_local_preview_stream();
  await presence();

  // TODO: right now the user ID is just the rank, might change to something else later.
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

  // Watch for peers to leave
  onChildRemoved(usersRef, (snapshot) => {
    const peerUserId = snapshot.key;
    if (peerUserId && peerUserId !== myUserIdStr) {
      handle_peer_left(peerUserId);
    }
  });
};

// TODO: add functinality to toggle mic
export const toggle_mic = (enabled: boolean) => {
  localStream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
};

// TODO: add functinality to toggle camera
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
  await remove(user_path(userRank));
  localStream?.getTracks().forEach((track) => track.stop());
  connections.clear();
};
