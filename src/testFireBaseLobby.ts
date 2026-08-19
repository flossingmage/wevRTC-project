import { db } from "./firebase";
import {
  ref,
  push,
  set,
  remove,
  onValue,
  onDisconnect,
  runTransaction,
} from "firebase/database";

export interface RoomData {
  started?: boolean;
  users?: Record<
    string,
    {
      joinedAt: object;
    }
  >;
}

export async function joinRoom(roomId: string): Promise<number> {
  const usersRef = ref(db, `rooms/${roomId}/users`);

  const connectionRank = await runTransaction(
    ref(db, `rooms/${roomId}/userCount`),
    (currentCount) => {
      return (currentCount || 0) + 1;
    },
  );

  const myRef = push(usersRef);

  await set(myRef, {
    connectionRank: connectionRank.snapshot.val(),
  });

  onDisconnect(myRef).remove();

  return connectionRank.snapshot.val();
}

export async function leaveRoom(roomId: string, userId: string): Promise<void> {
  await remove(ref(db, `rooms/${roomId}/users/${userId}`));
}

export function watchRoom(roomId: string, callback: (room: RoomData) => void) {
  return onValue(ref(db, `rooms/${roomId}`), (snapshot) => {
    callback((snapshot.val() as RoomData) || {});
  });
}

export async function startRoom(roomId: string): Promise<void> {
  await set(ref(db, `rooms/${roomId}/started`), true);
}

export function watchStarted(
  roomId: string,
  callback: (started: boolean) => void,
) {
  return onValue(ref(db, `rooms/${roomId}/started`), (snapshot) => {
    callback(snapshot.val() === true);
  });
}
