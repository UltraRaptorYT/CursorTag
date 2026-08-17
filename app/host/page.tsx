import HostClient from "./host-client";

export default async function HostPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const rawCode = Array.isArray(query.room) ? query.room[0] : query.room;
  return <HostClient initialRoomCode={rawCode ?? ""} />;
}

