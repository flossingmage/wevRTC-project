import { FastPeerConnection, type SignalServer } from "./netaware";

const webSocket = new WebSocket("ws://localhost:8080");

webSocket.addEventListener("open", () => {
  console.log("Connected to the server.");
});

export const connect = (isHost: boolean) => {
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

  const connection = new FastPeerConnection(signal_server, timeout_ms);
};
