import { FastPeerConnection, type SignalServer } from "./netaware";

const ws = new WebSocket("ws://localhost:8080");

ws.addEventListener("open", () => {
  console.log("Connected to the server.");
});

export const connect = async (isHost: boolean) => {
  console.log("Connecting as", isHost ? "host" : "client");
  const signal_server: SignalServer = {
    makes_first_move: isHost,
    send_signal_state: async (state: string) => {
      console.log("Sending signal state:", state);
    },
    error_handler: async () => {
      console.error("Fatal error occurred");
    },
  };
  const timeout_ms = 1000;

  const connection = new FastPeerConnection(signal_server, timeout_ms, ws);

  await connection.on_ready();

  connection.send("hello from the other side");
};
