import { FastPeerConnection, SignalServer } from "./netaware";

const signal_server: SignalServer = {
  makes_first_move: true,
  send_signal_state: async (state: string) => {
    console.log("Sending signal state:", state);
  },
  error_handler: async () => {
    console.error("Fatal error occurred");
  },
};
const timeout_ms = 1000;

const connection = new FastPeerConnection(signal_server, timeout_ms);
