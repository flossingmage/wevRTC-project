import { db } from "./firebase";
import { FastPeerConnection, type SignalServer } from "./netaware";
import {
  ref,
  onValue,
  child,
  remove,
  set,
  push,
  onDisconnect,
} from "firebase/database";

export type CallUIHooks = {
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (peerUserId: string, stream: MediaStream) => void;
  onPeerLeft: (peerUserId: string) => void;
  onStatusChange: (
    peerUserId: string,
    status: "connecting" | "connected" | "disconnected",
  ) => void;
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

/**
 * @param connectionId the connection ID from {@link make_connection_id}
 * @param gen the generation of this connection attempt, starting at 0
 * @returns ref to rooms/{roomId}/connections/{connectionId}/gen_{gen}, which holds
 * the offer, offerCandidates, answer, and answerCandidates for that generation.
 */
const connection_gen_ref = (connectionId: string, gen: number) =>
  ref(db, `rooms/${roomId}/connections/${connectionId}/gen_${gen}`);

const firebase_presence = async () => {
  const myUserRef = user_path(userRank);
  await set(myUserRef, { userRank });

  await set(child(myUserRef, "connected"), true);
  await onDisconnect(child(myUserRef, "connected")).set(false);
};

const host_with_firebase = async (
  connectionId: string,
  gen: number,
  connection: FastPeerConnection,
) => {
  const roomRef = connection_gen_ref(connectionId, gen);

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
  connectionId: string,
  gen: number,
  connection: FastPeerConnection,
) => {
  const roomRef = connection_gen_ref(connectionId, gen);

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
      uiHooks?.onStatusChange(peerUserId, "disconnected");
    },
  };

  const connection = new FastPeerConnection(signal_server, 1000);
  connections.set(peerUserId, connection);

  await connection.addMediaStream({ video: true, audio: true }, (stream) => {
    uiHooks?.onRemoteStream(peerUserId, stream);
  });

  uiHooks?.onStatusChange(peerUserId, "connecting");

  const connectionId = make_connection_id(userRank, peerUserId);

  onValue(child(user_path(peerUserId), "connected"), (snapshot) => {
    console.log(`peer ${peerUserId} connection state: ${snapshot.val()}`);
    // call ice restart
    if (!snapshot.val()) {
      
    }
  });

  // first connection attempt is generation 0
  const gen = 0;

  if (signal_server.makes_first_move) {
    host_with_firebase(connectionId, gen, connection);
  } else {
    join_with_firebase(connectionId, gen, connection);
  }

  console.log("Waiting for connection to be ready...");
  await connection.on_ready();

  uiHooks?.onStatusChange(peerUserId, "connected");
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
  // remove this user and their connection data from the room
  await remove(user_path(userRank));
  await Promise.all(
    [...connections.keys()].map((peerUserId) =>
      remove(
        ref(
          db,
          `rooms/${roomId}/connections/${make_connection_id(userRank, peerUserId)}`,
        ),
      ),
    ),
  );

  connections.forEach((conn) => conn.close());
  connections.clear();
  localStream?.getTracks().forEach((track) => track.stop());
};
