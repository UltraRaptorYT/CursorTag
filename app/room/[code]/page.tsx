import { notFound } from "next/navigation";
import { sanitizeRoomCode } from "@/lib/game/config";
import RoomClient from "./room-client";

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const roomCode = sanitizeRoomCode(code);
  if (roomCode.length < 4) notFound();
  return <RoomClient roomCode={roomCode} />;
}

