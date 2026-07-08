export type SignalServer = {
  /**
   * Which end of the connection initiates, i.e. makes the first move.
   */
  makes_first_move: boolean;
  /**
   * When we first establish a WebRTC connection a negotiation process occurs.
   * So, while the connection itself is entirely peer to peer with no server,
   * our two ends of the connection need to negotiate the connection itself first.
   * They would, for example, exchange IP addresses and which underlying connection method (TCP, UDP, etc.)
   * they support. This {@link send_signal_state} allows both of our servers to exchange shared state.
   * The channel is provided by the user of {@link FastPeerConnection}.
   *
   * @param state An arbitrary state string the server wants to send to the other end of the {@link FastPeerConnection}.
   * @returns A promise that is fullfilled when the message has been succesfully sent to the other end of
   * the connection. Note that the third-party negotiation channel need to guarantee an intrinsic ordering
   * scheme for messages.
   */
  send_signal_state: (state: string) => Promise<void>;
  /**
   * This error handler shall be called once by a {@link FastPeerConnection} whenever a fatal error occurs
   * that terminates the {@link FastPeerConnection}. It is guaranteed that {@link FastPeerConnection} has performed
   * necessary clean up work before calling {@link error_handler}.
   */
  error_handler: () => Promise<void>;
};

/**
 * A simple library for creating stable webrtc connections.
 * A connection fails completely if a dropped connection is
 * not restored within timeout_ms.
 */
export class FastPeerConnection {
  /**
   * Make a {@link FastPeerConnection} with a {@link signal_server} and {@link timeout_ms}.
   * The connection that makes the first move should begin its work here.
   */
  constructor(signal_server: SignalServer, timeout_ms: number) {}

  /**
   * Called by the third-party signaling mechanism
   * whenever a state update is propogated from the
   * other end of the peer connection.
   */
  async set_peer_signal_state(state: string): Promise<void> {}

  /**
   * Returns a promise that is fullfilled if a connection succesfully
   * connects, and fails if the connection irreparably fails and
   * times out. This method is useful if you have a thread that wants
   * to send messages using the peer connection. You would use it like so:
   *
   * @example ```
   * const connection = FastPeerConnection(...);
   * third_party_messaging_service.on_message(connection.set_peer_signal_state);
   * connection.send('this message will not be lost even though we have not fully connected.');
   * // At this point the FastPeerConnection will use the third-party service to negotiate a connection.
   * // This process takes time, so we can block our thread until it is complete.
   * await connection.on_ready();
   * // We've connected and can let our users know.
   * console.log('We have connected');
   * connection.send('Hi!!!');
   * ```
   */
  //on_ready(): Promise<void> {}

  /**
   * If you want to receive every message sent over this channel,
   * register the listener before updating the {@link peer_signal_state}.
   */
  listen(listener: (message: string) => void): void {}

  /**
   * Send data over the WebRTC channel. Messages should be enqueued if a
   * connection has not been established.
   */
  send(data: string): void {}

  /**
   * Gracefully shut down and clean up this end of the peer connection.
   */
  close(): void {}
}
