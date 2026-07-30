import { FastPeerConnection, type SignalServer } from "./netaware";

export const connect = async (isHost: boolean) => {
  const ws = new WebSocket("ws://localhost:8080");

  ws.addEventListener("open", () => {
    console.log("Connected to the server.");
  });

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
  let connection = null;
  connection = new FastPeerConnection(signal_server, timeout_ms);

  // add media
  const constraints = { video: true, audio: true };

  connection.addMediaStream(constraints);

  // continue connection
  connection.connect_with_webSockets(ws);

  if (isHost) {
    document.querySelectorAll("button").forEach((btn) => {
      if (btn.textContent === "start Connection") btn.remove();
    });

    const startButten = document.createElement("button") as HTMLButtonElement;
    startButten.textContent = "start Connection";
    startButten.addEventListener("click", () => {
      connection.send_webSocket_offer(ws);
    });
    document.body.appendChild(startButten);
  }

  await connection.on_ready();

  connection.send("hello from the other side", "message");

  // add moving mouse

  if (isHost) {
    console.log("making mouse channel");
    const mouseChannel = connection.createDataChannel("mouse");
    mouseChannel.addEventListener("open", () => {
      const OMouse = set_up_mouse(mouseChannel);
      connection.listen(mouseChannel, (message) => {
        const data = JSON.parse(message);
        move_mouse(data.x, data.y, OMouse);
      });
    });
  } else {
    const mouseChannel = await connection.getDataChannel("mouse");
    const OMouse = set_up_mouse(mouseChannel);
    connection.listen(mouseChannel, (message) => {
      const data = JSON.parse(message);
      move_mouse(data.x, data.y, OMouse);
    });
  }
};

function move_mouse(x: number, y: number, element: HTMLElement) {
  console.log("moving mouse");
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
}

function set_up_mouse(mouseChannel: RTCDataChannel) {
  const OMouse = document.createElement("div");

  OMouse.style.position = "fixed";
  OMouse.style.width = "10px";
  OMouse.style.height = "10px";
  OMouse.style.backgroundColor = "green";

  document.body.appendChild(OMouse);

  mouseChannel.addEventListener("message", (event) => {
    console.log("getting mouse");
    const data = JSON.parse(event.data);
    move_mouse(data.x, data.y, OMouse);
  });

  window.addEventListener("mousemove", (event: MouseEvent) => {
    const x = event.clientX;
    const y = event.clientY;
    if (mouseChannel.readyState === "open")
      mouseChannel.send(JSON.stringify({ x, y }));
  });
  return OMouse;
}
