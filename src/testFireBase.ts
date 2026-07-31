import { FastPeerConnection, type SignalServer } from "./netaware";

document.getElementById("text")!.innerHTML = "code ran";

export const host_room = async () => {
  const signal_server: SignalServer = {
    makes_first_move: true,
    send_signal_state: async (state: string) => {
      console.log("Sending signal state:", state);
    },
    error_handler: async () => {
      console.error("Fatal error occurred");
    },
  };

  const connection = new FastPeerConnection(signal_server, 1000);

  const constraints = { video: true, audio: true };

  await connection.addMediaStream(constraints);

  const roomId = Math.random().toString(36).substring(2);

  console.log(roomId);

  document.getElementById("text")!.innerHTML = roomId;

  connection.host_with_firebase(roomId);

  await connection.on_ready();

  connection.send("hello from the other side", "message");
};

export const join_room = async () => {
  const box = document.getElementById("roomId") as HTMLInputElement;
  const roomId = box.value;

  const signal_server: SignalServer = {
    makes_first_move: false,
    send_signal_state: async (state: string) => {
      console.log("Sending signal state:", state);
    },
    error_handler: async () => {
      console.error("Fatal error occurred");
    },
  };

  const connection = new FastPeerConnection(signal_server, 1000);

  const constraints = { video: true, audio: true };

  await connection.addMediaStream(constraints);

  connection.join_with_firebase(roomId);

  connection.send("this is before the connection is set up", "message");

  await connection.on_ready();

  connection.send("hello from the other side", "message");
};
