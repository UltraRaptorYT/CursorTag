export type RoomPhase = "lobby" | "playing" | "finished";

export type CursorPosition = {
  x: number;
  y: number;
};

export type RoomPlayer = {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  calibrated: boolean;
  position: CursorPosition;
  score: number;
};

export type Impact = {
  id: string;
  x: number;
  y: number;
  at: number;
  fromPlayerId: string;
  toPlayerId: string;
};

export type RoomSnapshot = {
  phase: RoomPhase;
  hostConnected: boolean;
  players: RoomPlayer[];
  itPlayerId: string | null;
  round: number;
  roundEndsAt: number | null;
  roundDurationMs: number | null;
  freezeUntil: number | null;
  frozenPlayerIds: string[];
  impact: Impact | null;
  maxPlayers: number;
  collisionRadius: number;
};

export type ClientRoomMessage =
  | { type: "join"; payload: { name: string } }
  | { type: "calibrated" }
  | {
      type: "cursor";
      payload: CursorPosition & { sequence: number; clientSentAt: number };
    }
  | { type: "host-start"; payload: { aspectRatio: number } }
  | { type: "host-viewport"; payload: { aspectRatio: number } }
  | { type: "host-end" }
  | { type: "host-reset" }
  | { type: "request-snapshot" }
  | { type: "ping"; payload: { id: string; clientSentAt: number } };

export type ServerRoomMessage =
  | { type: "connected"; payload: { clientId: string; snapshot: RoomSnapshot } }
  | { type: "snapshot"; payload: RoomSnapshot }
  | {
      type: "cursor";
      payload: CursorPosition & {
        playerId: string;
        sequence: number;
        clientSentAt: number;
        serverSentAt: number;
      };
    }
  | { type: "tag"; payload: RoomSnapshot }
  | {
      type: "timeout";
      payload: { timedOutPlayerId: string; snapshot: RoomSnapshot };
    }
  | {
      type: "pong";
      payload: { id: string; clientSentAt: number; serverSentAt: number };
    }
  | { type: "error"; message: string };
