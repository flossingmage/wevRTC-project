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

type signal =
  | { type: "offer"; offer: RTCSessionDescriptionInit; gen: number }
  | { type: "answer"; answer: RTCSessionDescriptionInit; gen: number }
  | { type: "ice_candidate"; candidate: RTCIceCandidateInit; gen: number }
  | { type: "ping" };

/**
 * A simple library for creating stable webrtc connections.
 * A connection fails completely if a dropped connection is
 * not restored within timeout_ms.
 * TODO: implement timeout_ms, make it so fastpeerconnection uses signal_server
 * TODO: make fastpeerconnection more generic (get rid of the messeging system and make it so that the user can implement their own messeging system,
 * TODO: change media stream
 */
export class FastPeerConnection {
  private readonly signal_server: SignalServer;
  private readonly timeout_ms: number;
  private readonly local_stream: MediaStream | null = null;
  private readonly on_remote_stream: ((stream: MediaStream) => void) | null =
    null;
  private connection!: RTCPeerConnection;
  private data_channels: Map<string, RTCDataChannel>;
  private gen = 0;
  private waiting_for_connection = false;
  private ready_waiters: (() => void)[] = [];
  private disconnect_timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Make a {@link FastPeerConnection} with a {@link signal_server} and {@link timeout_ms}.
   * The connection that makes the first move should begin its work here.
   */
  constructor(
    signal_server: SignalServer,
    timeout_ms: number,
    local_stream: MediaStream | null = null,
    on_remote_stream: ((stream: MediaStream) => void) | null = null,
  ) {
    this.signal_server = signal_server;
    this.timeout_ms = timeout_ms;
    this.data_channels = new Map<string, RTCDataChannel>();
    this.local_stream = local_stream;
    this.on_remote_stream = on_remote_stream;

    if (signal_server.makes_first_move) {
      this.offer().catch(() => this.signal_server.error_handler());
    } else {
      this.signal_server.send_signal_state(JSON.stringify({ type: "ping" }));
    }
  }

  start_Connection_Attempt(gen: number) {
    this.connection?.close();
    this.gen = gen;
    const config = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    };

    this.connection = new RTCPeerConnection(config);

    this.local_stream?.getTracks().forEach((track) => {
      this.connection.addTrack(track, this.local_stream!);
    });

    this.connection.ontrack = (event) => {
      this.on_remote_stream?.(event.streams[0]);
    };

    this.connection.onicecandidate = async (event) => {
      event.candidate &&
        this.signal_server.send_signal_state(
          JSON.stringify({
            type: "ice_candidate",
            candidate: event.candidate,
            gen: this.gen,
          }),
        );
    };

    const current_con = this.connection;
    this.connection.onconnectionstatechange = () => {
      if (current_con !== this.connection) return; // ignore old connections
      if (this.connection.connectionState === "connected") {
        clearTimeout(this.disconnect_timer!);
        this.ready_waiters.forEach((resolve) => resolve());
        this.ready_waiters = [];
      } else if (this.connection.connectionState === "disconnected") {
        this.disconnect_timer = setTimeout(() => {}, this.timeout_ms);
      } else if (this.connection.connectionState === "failed") {
      }
    };
  }

  /**
   * Called by the third-party signaling mechanism
   * whenever a state update is propogated from the
   * other end of the peer connection.
   */
  async set_peer_signal_state(state: string): Promise<void> {
    const signal: signal = JSON.parse(state);
    if (signal.type === "ping") {
      if (this.signal_server.makes_first_move) await this.offer();
      return;
    }

    if (signal.type === "offer") {
      this.start_Connection_Attempt(signal.gen);
      await this.connection.setRemoteDescription(signal.offer);
      const answer = await this.connection.createAnswer();
      await this.connection.setLocalDescription(answer);
      await this.signal_server.send_signal_state(
        JSON.stringify({ type: "answer", answer, gen: this.gen }),
      );
    }

    if (signal.gen !== this.gen) return; // ignore old signals

    if (signal.type === "answer") {
      await this.connection.setRemoteDescription(signal.answer);
    }

    if (signal.type === "ice_candidate") {
      await this.connection.addIceCandidate(signal.candidate);
    }
  }

  async offer(): Promise<void> {
    if (this.waiting_for_connection) return;
    this.waiting_for_connection = true;
    this.start_Connection_Attempt(Date.now());
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    await this.signal_server.send_signal_state(
      JSON.stringify({ type: "offer", offer, gen: this.gen }),
    );
  }

  /**
   * Creates a new data channel. if a listener is provided, it will be called whenever a message is received on the data channel.
   * @param label The label of the data channel to create.
   * @param listener An optional listener to receive messages from the data channel.
   * @returns The created data channel.
   */
  createDataChannel(label: string, listener?: (message: string) => void) {
    const data_channel = this.connection.createDataChannel(label);
    this.setDataChannel(data_channel);
    this.data_channels.set(data_channel.label, data_channel);
    data_channel.onopen = () => {
      this.listen(
        data_channel,
        listener
          ? listener
          : (message) => {
              console.log(message);
            },
      );
    };
    return data_channel;
  }

  /**
   * gets the data channel with a given label. If the data channel does not exist, it will wait until it is created and then return it.
   * @param label The label of the data channel to get.
   * @returns A promise that resolves to the data channel with the given label.
   */
  getDataChannel(label: string): Promise<RTCDataChannel> {
    const data_channel = this.data_channels.get(label);
    if (data_channel) return Promise.resolve(data_channel);

    return new Promise((resolve) => {
      const listener = (event: RTCDataChannelEvent) => {
        const data_channel = event.channel;
        if (data_channel.label !== label) return;

        this.data_channels.set(label, data_channel);
        this.connection.removeEventListener("datachannel", listener);
        resolve(data_channel);
      };
      this.connection.addEventListener("datachannel", listener);
    });
  }

  /**
   * sets the data channel in data_channels map
   * @param channel RTCDataChannel to set.
   */
  setDataChannel(channel: RTCDataChannel) {
    const data_channel = channel;
    this.data_channels.set(data_channel.label, data_channel);
  }

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
  on_ready(): Promise<void> {
    if (this.connection.connectionState === "connected")
      return Promise.resolve();
    return new Promise((resolve) => {
      this.ready_waiters.push(resolve);
    });
  }

  /**
   * If you want to receive every message sent over this channel,
   * register the listener before updating the {@link peer_signal_state}.
   */
  listen(data_channel: RTCDataChannel, listener: (message: string) => void) {
    data_channel.addEventListener("message", (event) => {
      listener(event.data);
    });
  }

  /**
   * Send data over the WebRTC channel. Messages should be enqueued if a
   * connection has not been established.
   * TODO: might remove message queue or the entire send method. Might make it so that the user has to implement their own messaging system.
   * @param data The data to send.
   * @param label The label of the data channel to send the data over.
   */
  send(data: string, label: string): void {
    this.data_channels.get(label)?.send(data);
  }

  /**
   * Gracefully shut down and clean up this end of the peer connection.
   */
  close(): void {
    if (!this.connection) return;

    // close media
    this.connection.getSenders().forEach((sender) => sender.track?.stop());

    // close data channels
    for (const channel of this.data_channels.values()) {
      channel.close();
    }
    this.data_channels.clear();

    // close on something
    this.connection.onconnectionstatechange = null;
    this.connection.ondatachannel = null;
    this.connection.onicecandidate = null;
    this.connection.ontrack = null;

    //close connection
    this.connection.close();
  }
}
