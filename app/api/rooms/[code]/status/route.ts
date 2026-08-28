import { sanitizeRoomCode } from "@/lib/game/config";

function getStatusUrl(roomCode: string) {
  const configuredUrl = process.env.NEXT_PUBLIC_CURSOR_TAG_WS_URL?.trim();
  if (!configuredUrl) return null;

  const url = new URL(configuredUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.pathname = `${url.pathname.replace(/\/$/, "")}/rooms/${encodeURIComponent(roomCode)}/status`;
  url.search = "";
  url.hash = "";
  return url;
}

export async function GET(
  _request: Request,
  context: RouteContext<"/api/rooms/[code]/status">,
) {
  const { code: rawCode } = await context.params;
  const roomCode = sanitizeRoomCode(rawCode);
  if (roomCode !== rawCode.toUpperCase() || roomCode.length < 4) {
    return Response.json({ exists: false }, { status: 400 });
  }

  const statusUrl = getStatusUrl(roomCode);
  if (!statusUrl) {
    return Response.json({ error: "Game server is not configured" }, { status: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_500);
  try {
    const response = await fetch(statusUrl, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return Response.json({ error: "Game server status check failed" }, { status: 502 });
    }
    const result = (await response.json()) as { exists?: boolean };
    return Response.json(
      { exists: result.exists === true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Game server is unavailable" }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }
}
