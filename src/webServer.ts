import { WebSocketServer, WebSocket } from "ws";

const webSocket = new WebSocketServer({ port: 8080 });

webSocket.on("connection", (ws: WebSocket) => {
  console.log("New client connected" + ws);

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});
