import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        waitingRoom: resolve(__dirname, "waiting-room.html"),
        callRoom: resolve(__dirname, "call-room.html"),
      },
    },
  },
});
