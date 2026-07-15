import { WebSocketServer, WebSocket } from "ws";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws: WebSocket) => {
  console.log("New client connected" + ws);

  ws.on("message", (message) => {
    console.log("Received message from client");
    const data = JSON.parse(message.toString());

    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
        console.log("Sent message to other clients");
      }
    });
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});
