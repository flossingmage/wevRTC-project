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
     * @param state An arbitrary state string you want to send to the other end of the {@link FastPeerConnection}.
     * You may assume that your own implementation of {@link FastPeerConnection} is used on both ends of the
     * connection. We recommend having {@link send_signal_state} send one shared state used by both ends of
     * the connection. The reference solution, for example, sends one giant stringified JSON containing all shared
     * signal data at all times.
     * @returns A promise that is fullfilled when the message has been succesfully sent to the other end of
     * the connection. Note that the third-party negotiation channel need not guarantee any intrinsic ordering
     * scheme for messages. You should assume that the signal handler is reliable and will not drop messages you
     * send, however. You also should not assume that stale data from another connection will not be incidentally
     * sent through the connection and validate any message recieved.
     */
    send_signal_state: (state: string) => Promise<void>;
    /**
     * This error handler shall be called once by a {@link FastPeerConnection} whenever a fatal error occurs
     * that terminates the {@link FastPeerConnection}. It is guaranteed that {@link FastPeerConnection} has performed
     * necessary clean up work before calling {@link error_handler}.
     *
     * @returns A potentially void promise.
     */
    error_handler: () => Promise<void>;
};
export type SignalMessage = {
    type: 'start' | 'ice_candidate' | 'description';
    connection_id: string | undefined;
    value?: string;
};

/**
 * A simple library for creating stable webrtc connections.
 * A connection fails completely if a dropped connection is
 * not restored within timeout_ms.
 */
export class FastPeerConnection {
    #connection: RTCPeerConnection;
    #signal_server: SignalServer;
    #message_bus: RTCDataChannel;
    #remote_state: SignalMessage[];
    #last_bad_event_time: number | undefined;
    #timeout_handler: number | undefined;
    #disconnected_timeout: number | undefined;
    #pending_messages: string[];
    #listeners: ((data: string) => void)[];
    #local_state: SignalMessage[];
    #connection_id: string | undefined;

    constructor(signal_server: SignalServer, timeout_ms: number) {
        this.#signal_server = signal_server;
        this.#remote_state = [];
        this.#local_state = [];
        this.#pending_messages = [];
        this.#listeners = [];

        const { makes_first_move } = this.#signal_server;
        this.#connection = new RTCPeerConnection({
            iceServers: [
                {
                    urls: 'stun:stun.l.google.com:19302',
                },
            ],
        });

        this.#message_bus = this.#connection.createDataChannel('messages', {
            id: 0,
            negotiated: true,
        });
        this.#message_bus.addEventListener('open', () => {
            for (const pending_message of this.#pending_messages) {
                this.#message_bus.send(pending_message);
            }
            this.#pending_messages = [];
        });

        this.#message_bus.addEventListener('close', () => {
            this.#last_bad_event_time = Date.now();
            if (this.#last_bad_event_time) {
                this.#message_bus = this.#connection.createDataChannel(
                    'messages',
                    {
                        id: 0,
                        negotiated: true,
                    }
                );
                this.#message_bus.addEventListener('open', () => {
                    this.#last_bad_event_time = undefined;
                    for (const pending_message of this.#pending_messages) {
                        this.#message_bus.send(pending_message);
                    }
                    this.#pending_messages = [];
                });

                for (const listener of this.#listeners) {
                    this.#message_bus.addEventListener('message', (ev) =>
                        listener(ev.data)
                    );
                }
            }
        });

        this.#timeout_handler = setInterval(() => {
            if (
                this.#last_bad_event_time &&
                this.#last_bad_event_time + timeout_ms <= Date.now()
            ) {
                this.close();
                this.#signal_server.error_handler();
            }
        }, 1_000);

        this.#connection.addEventListener('connectionstatechange', () => {
            const ice_state = this.#connection.iceConnectionState;
            console.debug(
                `ice state = ${ice_state}, channel state = ${this.#connection.connectionState}, data channel state = ${this.#message_bus.readyState}`
            );

            if (this.#connection.connectionState !== 'connected') {
                this.#last_bad_event_time = Date.now();
            } else {
                this.#last_bad_event_time = undefined;
            }

            if (
                makes_first_move &&
                this.#connection.connectionState === 'failed'
            ) {
                this.#connection.restartIce();
            } else if (
                makes_first_move &&
                this.#connection.connectionState === 'disconnected'
            ) {
                this.#disconnected_timeout = setTimeout(() => {
                    if (this.#connection.connectionState === 'disconnected') {
                        this.#connection.restartIce();
                    }
                    this.#disconnected_timeout = undefined;
                }, 5_000);
            } else if (
                makes_first_move &&
                this.#disconnected_timeout !== undefined
            ) {
                clearTimeout(this.#disconnected_timeout);
                this.#disconnected_timeout = undefined;
            }
        });

        if (makes_first_move) {
            this.#last_bad_event_time = Date.now();
            this.#connection_id = `${Date.now()}:${Math.floor(Math.random() * 100_000)}`;
            this.#update_local_state({ type: 'start' });
            this.#connection.addEventListener('negotiationneeded', async () => {
                await this.#connection.setLocalDescription(
                    await this.#connection.createOffer()
                );
                this.#update_local_state({
                    type: 'description',
                    value: JSON.stringify(
                        this.#connection.localDescription?.toJSON()
                    ),
                });
            });
        }

        this.#connection.addEventListener('icecandidate', async (event) => {
            const candidate = event.candidate?.toJSON();
            if (candidate) {
                this.#update_local_state({
                    type: 'ice_candidate',
                    value: JSON.stringify(candidate),
                });
            }
        });
    }

    #update_local_state(message: Omit<SignalMessage, 'connection_id'>) {
        this.#local_state.push({
            ...message,
            connection_id: this.#connection_id,
        });
        this.#signal_server.send_signal_state(
            JSON.stringify(this.#local_state)
        );
    }

    async set_peer_signal_state(state: string) {
        let signal_state_raw: unknown;

        try {
            signal_state_raw = JSON.parse(state) as unknown;
        } catch (e: unknown) {
            console.warn(`Bad signaling state: ${state}`);
            console.warn(e);
            return;
        }

        if (!Array.isArray(signal_state_raw)) {
            console.warn(`Bad signaling state: ${state}`);
            return;
        }

        for (const message of signal_state_raw) {
            if (
                !(
                    typeof message === 'object' &&
                    message !== null &&
                    'type' in message &&
                    'connection_id' in message &&
                    typeof message.type === 'string' &&
                    typeof message.connection_id === 'string' &&
                    (message.type === 'description' ||
                        message.type === 'ice_candidate' ||
                        message.type === 'start') &&
                    (!('value' in message) || typeof message.value === 'string')
                )
            ) {
                console.warn(`Bad signaling state: ${state}`);
                return;
            }
        }

        if (this.#connection_id === undefined) {
            this.#connection_id = (signal_state_raw as SignalMessage[]).find(
                ({ type }) => type === 'start'
            )?.connection_id;
        }

        const signal_states = (signal_state_raw as SignalMessage[])
            .filter(
                ({ connection_id }) => connection_id === this.#connection_id
            )
            .slice(this.#remote_state.length);

        this.#remote_state = (signal_state_raw as SignalMessage[]).filter(
            ({ connection_id }) => connection_id === this.#connection_id
        );

        for (const { type, value, connection_id } of signal_states) {
            try {
                if (type === 'start') {
                    this.#connection_id = connection_id;
                } else if (type === 'ice_candidate' && value !== undefined) {
                    await this.#connection.addIceCandidate(
                        new RTCIceCandidate(
                            JSON.parse(value) as RTCIceCandidateInit
                        )
                    );
                } else if (value !== undefined) {
                    await this.#connection.setRemoteDescription(
                        JSON.parse(value) as RTCSessionDescriptionInit
                    );
                    if (!this.#signal_server.makes_first_move) {
                        // If we are the non-initializer, this is an offer and we must respond.
                        await this.#connection.setLocalDescription(
                            await this.#connection.createAnswer()
                        );

                        this.#update_local_state({
                            type: 'description',
                            value: JSON.stringify(
                                this.#connection.localDescription?.toJSON()
                            ),
                        });
                    }
                }
            } catch (e: unknown) {
                console.warn(
                    `Failed to add message of ${type} with value ${value}`
                );
                console.warn(e);
            }
        }
    }

    on_ready() {
        return new Promise((resolve, reject) => {
            if (this.#connection.connectionState === 'connected') {
                resolve(undefined);
            } else if (this.#connection.connectionState === 'closed') {
                reject(undefined);
            } else {
                this.#connection.addEventListener(
                    'connectionstatechange',
                    () => {
                        if (this.#connection.connectionState === 'connected') {
                            resolve(undefined);
                        } else if (
                            this.#connection.connectionState === 'closed'
                        ) {
                            reject(undefined);
                        }
                    }
                );
            }
        });
    }

    /**
     * If you want to receive every message sent over this channel,
     * register the listener before updating the peer_signal_state.
     */
    listen(listener: (message: string) => void) {
        this.#message_bus.addEventListener('message', (ev) =>
            listener(ev.data)
        );
        this.#listeners.push(listener);
    }

    send(data: string) {
        if (this.#message_bus.readyState === 'open') {
            this.#message_bus.send(data);
        } else {
            this.#pending_messages.push(data);
        }
    }

    close() {
        if (this.#timeout_handler === undefined) {
            return;
        }

        if (this.#disconnected_timeout !== undefined) {
            clearTimeout(this.#disconnected_timeout);
            this.#disconnected_timeout = undefined;
        }

        clearInterval(this.#timeout_handler);
        this.#timeout_handler = undefined;
        this.#message_bus.close();
        this.#connection.close();
    }
}
