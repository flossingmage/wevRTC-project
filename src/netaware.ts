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
   * The channel is provi
   * ded by the user of {@link FastPeerConnection}.
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
  private readonly signal_server: SignalServer;
  // private readonly timeout_ms: number;
  private readonly message_queue: string[];
  private readonly connection: RTCPeerConnection;
  private data_channels: Map<string, RTCDataChannel>;

  /**
   * Make a {@link FastPeerConnection} with a {@link signal_server} and {@link timeout_ms}.
   * The connection that makes the first move should begin its work here.
   */
  constructor(signal_server: SignalServer, timeout_ms: number) {
    this.signal_server = signal_server;
    // this.timeout_ms = timeout_ms;
    this.message_queue = [];
    this.data_channels = new Map<string, RTCDataChannel>();

    const config = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    };
    this.connection = new RTCPeerConnection(config);

    if (this.signal_server.makes_first_move) {
      const data_channel = this.createDataChannel("message");
      data_channel.addEventListener("open", () => {
        while (this.message_queue.length > 0) {
          this.send(String(this.message_queue.shift()), "message");
        }
      });
    } else {
      this.connection.ondatachannel = (event) => {
        this.addDataChannel(event);
      };

      const listener = (event: RTCDataChannelEvent) => {
        if (event.channel.label !== "message") return;

        while (this.message_queue.length > 0) {
          this.send(String(this.message_queue.shift()), "message");
        }

        this.connection.removeEventListener("datachannel", listener);
      };
      this.connection.addEventListener("datachannel", listener);
    }

    this.connection.onconnectionstatechange = () => {
      switch (this.connection.connectionState) {
        case "connected":
          console.log("Connection established");
          break;
        case "disconnected":
          console.log("Connection disconnected");
          this.close();
          break;
        case "failed":
          console.log("Connection failed");
          break;
        case "closed":
          console.log("Connection closed");
          this.close();
          break;
      }
    };
  }

  connect_with_webSockets(ws: WebSocket) {
    this.connection.onicecandidate = (event) => {
      if (event.candidate) {
        if (ws.readyState === ws.OPEN)
          ws.send(
            JSON.stringify({
              type: "ice-candidate",
              candidate: event.candidate,
            }),
          );
      }
    };

    ws.onmessage = async (message) => {
      const data = JSON.parse(message.data);
      switch (data.type) {
        case "offer":
          await this.connection.setRemoteDescription(
            new RTCSessionDescription(data.offer),
          );
          const answer = await this.connection.createAnswer();
          await this.connection.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: "answer", answer }));
          ws.close();
          break;
        case "answer":
          await this.connection.setRemoteDescription(
            new RTCSessionDescription(data.answer),
          );
          ws.close();
          break;
        case "ice-candidate":
          await this.connection.addIceCandidate(
            new RTCIceCandidate(data.candidate),
          );
          break;
      }
    };
  }

  send_webSocket_offer(ws: WebSocket) {
    this.connection.createOffer().then(async (offer) => {
      await this.connection.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: "offer", offer }));
    });
  }

  createDataChannel(label: string) {
    const data_channel = this.connection.createDataChannel(label);
    this.data_channels.set(data_channel.label, data_channel);
    data_channel.onopen = () => {
      this.listen(data_channel, (message) => {
        console.log(message);
      });
    };
    return data_channel;
  }

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

  addDataChannel(event: RTCDataChannelEvent) {
    const data_channel = event.channel;
    this.data_channels.set(data_channel.label, data_channel);
    this.listen(data_channel, (message) => {
      console.log(message);
    });
  }

  /**
   * establishes media stream between peers.
   * puts videos in HTMLVideoElements with the id=localVideo and id=remoteVideo if they exist
   * @param constraints
   */
  async addMediaStream(constraints: MediaStreamConstraints) {
    const localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localStream.getTracks().forEach((track) => {
      this.connection.addTrack(track, localStream);
    });

    const localVideo = document.querySelector<HTMLVideoElement>("#localVideo");
    if (localVideo) localVideo.srcObject = localStream;

    this.connection.addEventListener("track", async (event) => {
      console.log("getting other track");
      const [remoteStream] = event.streams;
      const remoteVideo =
        document.querySelector<HTMLVideoElement>("#remoteVideo");
      if (remoteVideo) remoteVideo.srcObject = remoteStream;
    });
  }

  /**
   * Called by the third-party signaling mechanism
   * whenever a state update is propogated from the
   * other end of the peer connection.
   */
  // async set_peer_signal_state(state: string): Promise<void> {}

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
    return new Promise((resolve, reject) => {
      if (this.connection.connectionState === "connected") {
        console.log("Connection is ready.");
        resolve();
      } else if (this.connection.connectionState === "failed") {
        console.log("Connection failed.");
        reject();
      } else {
        this.connection.addEventListener("connectionstatechange", () => {
          if (this.connection.connectionState === "connected") {
            console.log("Connection is ready.");
            resolve();
          } else if (this.connection.connectionState === "failed") {
            console.log("Connection failed.");
            reject();
          }
        });
      }
    });
  }

  /**
   * If you want to receive every message sent over this channel,
   * register the listener before updating the {@link peer_signal_state}.
   */
  listen(
    data_channel: RTCDataChannel,
    listener: (message: string) => void,
  ): void {
    data_channel.addEventListener("message", (event) => {
      listener(event.data);
    });
  }

  /**
   * Send data over the WebRTC channel. Messages should be enqueued if a
   * connection has not been established.
   */
  send(data: string, label: string): void {
    if (
      !this.data_channels.get(label) ||
      this.data_channels.get(label)!.readyState !== "open"
    ) {
      if (label === "message") this.message_queue.push(data);
    } else {
      this.data_channels.get(label)!.send(data);
    }
  }

  /**
   * Gracefully shut down and clean up this end of the peer connection.
   */
  close(): void {
    if (!this.connection) return;

    // close media
    this.connection.getSenders().forEach((sender) => sender.track?.stop());

    const localVideo = document.querySelector<HTMLVideoElement>("#localVideo");
    if (localVideo) localVideo.srcObject = null;

    const remoteVideo =
      document.querySelector<HTMLVideoElement>("#remoteVideo");
    if (remoteVideo) remoteVideo.srcObject = null;

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
