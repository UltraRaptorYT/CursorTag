import { redirect } from "next/navigation";
import { sanitizeRoomCode } from "@/lib/game/config";

export default async function ControllerRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const rawRoom = Array.isArray(params.room) ? params.room[0] : params.room;
  const roomCode = sanitizeRoomCode(rawRoom ?? "");
  redirect(roomCode ? `/room/${roomCode}` : "/");
}

