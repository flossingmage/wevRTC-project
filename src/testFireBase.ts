import { db } from "./firebase";
import { FastPeerConnection, type SignalServer } from "./netaware";
import {
  ref,
  onValue,
  child,
  remove,
  set,
  onDisconnect,
  onChildAdded,
  push,
} from "firebase/database";

export type CallUIHooks = {
  on_local_stream: (stream: MediaStream) => void;
  on_remote_stream: (peer_user_id: string, stream: MediaStream) => void;
  on_peer_left: (peer_user_id: string) => void;
  on_status_change: (
    peer_user_id: string,
    status: "connecting" | "connected" | "disconnected",
  ) => void;
};

//get info from URL
const params = new URLSearchParams(window.location.search);
const room_id = params.get("code")!;
const user_rank = params.get("rank")!;

const connections = new Map<string, FastPeerConnection>();
const unsub_listeners = new Map<string, () => void>();

let ui_hooks: CallUIHooks | null = null;
let local_stream: MediaStream | null = null;

const get_local_stream = async (): Promise<MediaStream> => {
  if (local_stream) return local_stream;
  local_stream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });
  ui_hooks?.on_local_stream(local_stream);
  return local_stream;
};

const user_path = (user_id: string | number) =>
  ref(db, `rooms/${room_id}/users/${user_id}`);

/**
 * @param a connection rank of the first user
 * @param b connection rank of the second user
 * @returns the connection ID to where the connection prosses is stored in the db.
 */
const make_connection_id = (a: string, b: string) => [a, b].sort().join("_");

const connection_path = (peer_user_id: string) =>
  ref(
    db,
    `rooms/${room_id}/connections/${make_connection_id(user_rank, peer_user_id)}`,
  );

const firebase_presence = async () => {
  const my_user_ref = user_path(user_rank);
  await set(my_user_ref, { userRank: user_rank });

  await set(child(my_user_ref, "connected"), true);
  await onDisconnect(my_user_ref).remove();
};

const create_connection = async (
  peer_user_id: string,
  local_stream: MediaStream,
) => {
  console.log(`Creating connection with peer ${peer_user_id}`);

  const conn_ref = connection_path(peer_user_id);
  const sendRef = child(conn_ref, user_rank);
  const receiveRef = child(conn_ref, peer_user_id);

  const signal_server: SignalServer = {
    makes_first_move: Number(user_rank) < Number(peer_user_id),
    send_signal_state: async (state: string) => {
      await push(sendRef, state);
    },
    error_handler: async () => {
      console.error("Fatal error occurred");
      ui_hooks?.on_status_change(peer_user_id, "disconnected");
    },
  };

  const connection = new FastPeerConnection(
    signal_server,
    1000,
    local_stream,
    (remote_stream) => {
      ui_hooks?.on_remote_stream(peer_user_id, remote_stream);
    },
  );

  connections.set(peer_user_id, connection);

  const unsub_receive = onChildAdded(receiveRef, async (snapshot) => {
    const state = snapshot.val();
    await connection.set_peer_signal_state(state);
  });

  unsub_listeners.set(peer_user_id, unsub_receive);

  ui_hooks?.on_status_change(peer_user_id, "connecting");

  console.log("Waiting for connection to be ready...");
  await connection.on_ready();

  ui_hooks?.on_status_change(peer_user_id, "connected");
};

const handle_peer_left = (peer_user_id: string) => {
  console.log(`Peer ${peer_user_id} has left the call`);
  unsub_listeners.get(peer_user_id)?.();
  unsub_listeners.delete(peer_user_id);
  connections.get(peer_user_id)?.close();
  connections.delete(peer_user_id);

  remove(connection_path(peer_user_id));
  ui_hooks?.on_peer_left(peer_user_id);
};

export const register_ui_hooks = (hooks: CallUIHooks) => {
  ui_hooks = hooks;
};

export const begin_connection = async () => {
  console.log("beginning connection");
  const local_stream = await get_local_stream();
  await firebase_presence();

  // right now the user ID is just the rank, might change to something else later.
  const my_user_id_str = user_rank;
  const users_ref = ref(db, `rooms/${room_id}/users`);

  // Watch for peers to join
  onValue(users_ref, (snapshot) => {
    const current_peers = new Set<string>();
    snapshot.forEach((user) => {
      const peer_user_id = user.key;
      if (!peer_user_id || peer_user_id === my_user_id_str) return;
      current_peers.add(peer_user_id!);
      if (!connections.has(peer_user_id)) {
        create_connection(peer_user_id, local_stream);
      }
    });

    // Watch for peers to leave
    connections.forEach((_conn, peer_user_id) => {
      if (!current_peers.has(peer_user_id)) {
        handle_peer_left(peer_user_id);
      }
    });
  });
};

export const toggle_mic = (enabled: boolean) => {
  local_stream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
};

export const toggle_camera = (enabled: boolean) => {
  local_stream?.getVideoTracks().forEach((track) => {
    track.enabled = enabled;
  });
};

export const leave_call = async () => {
  // remove this user and their connection data from the room
  await remove(user_path(user_rank));
  await Promise.all(
    [...connections.keys()].map((peer_user_id) =>
      remove(
        ref(
          db,
          `rooms/${room_id}/connections/${make_connection_id(user_rank, peer_user_id)}`,
        ),
      ),
    ),
  );

  connections.forEach((conn) => conn.close());
  connections.clear();
  local_stream?.getTracks().forEach((track) => track.stop());
};
