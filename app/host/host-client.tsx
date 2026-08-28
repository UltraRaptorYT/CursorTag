"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Check,
  CircleAlert,
  CircleHelp,
  Expand,
  LoaderCircle,
  Move3d,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Snail,
  Snowflake,
  Sparkles,
  Smartphone,
  Star,
  ShieldCheck,
  Trophy,
  Users,
  Zap,
  WifiOff,
  X,
} from "lucide-react";

import { CursorTagLogo } from "@/components/cursor-tag-logo";
import {
  GAME_CONFIG,
  LEGACY_STARTING_LIVES,
  generateRoomCode,
  sanitizeRoomCode,
} from "@/lib/game/config";
import {
  createRoomSocket,
  type RoomConnectionStatus,
  type RoomSocket,
} from "@/lib/realtime/room";
import {
  normalizeRoomSnapshot,
  type ArenaPowerUp,
  type PowerUpMode,
  type PowerUpType,
  type RoomPlayer,
  type RoomSnapshot,
  type ServerRoomMessage,
} from "@/lib/realtime/types";

function emptySnapshot(): RoomSnapshot {
  return {
    phase: "lobby",
    hostConnected: false,
    players: [],
    itPlayerId: null,
    round: 0,
    roundEndsAt: null,
    roundDurationMs: null,
    freezeUntil: null,
    frozenPlayerIds: [],
    protectedPlayerId: null,
    invulnerableUntil: null,
    impact: null,
    powerUps: [],
    powerUpEvent: null,
    powerUpMode: "normal",
    maxPlayers: GAME_CONFIG.maxPlayers,
    maxLives: LEGACY_STARTING_LIVES,
    maxRounds: GAME_CONFIG.defaultRounds,
    roundSeconds: GAME_CONFIG.defaultRoundSeconds,
    collisionRadius: GAME_CONFIG.collisionRadius,
  };
}

export default function HostClient({
  initialRoomCode,
}: {
  initialRoomCode: string;
}) {
  const [roomCode, setRoomCode] = useState(() =>
    sanitizeRoomCode(initialRoomCode),
  );
  const [roomUrl, setRoomUrl] = useState("");
  const [status, setStatus] = useState<RoomConnectionStatus>("connecting");
  const [snapshot, setSnapshot] = useState<RoomSnapshot>(emptySnapshot);
  const [now, setNow] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [howToOpen, setHowToOpen] = useState(false);
  const socketRef = useRef<RoomSocket | null>(null);
  const pendingCursorsRef = useRef<Record<string, { x: number; y: number }>>(
    {},
  );
  const cursorFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const code = roomCode || generateRoomCode();
      if (!roomCode) {
        setRoomCode(code);
        window.history.replaceState(null, "", `/host?room=${code}`);
      }
      setRoomUrl(`${window.location.origin}/room/${code}`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [roomCode]);

  useEffect(() => {
    if (!roomCode) return;
    const storageKey = `cursor-tag-host-${roomCode}`;
    const hostId = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
    sessionStorage.setItem(storageKey, hostId);

    function handleMessage(message: ServerRoomMessage) {
      if (message.type === "connected") {
        setSnapshot(normalizeRoomSnapshot(message.payload.snapshot));
        if (message.payload.snapshot.phase === "playing") setNow(Date.now());
      }
      if (message.type === "snapshot" || message.type === "tag") {
        pendingCursorsRef.current = {};
        setSnapshot(normalizeRoomSnapshot(message.payload));
        if (message.payload.phase === "playing") setNow(Date.now());
      }
      if (message.type === "timeout") {
        pendingCursorsRef.current = {};
        setSnapshot(normalizeRoomSnapshot(message.payload.snapshot));
        setNow(Date.now());
        setNotice("Runners survived +1");
        window.setTimeout(() => setNotice(null), 1_800);
      }
      if (message.type === "cursor") {
        pendingCursorsRef.current[message.payload.playerId] = {
          x: message.payload.x,
          y: message.payload.y,
        };
        if (cursorFrameRef.current === null) {
          cursorFrameRef.current = window.requestAnimationFrame(() => {
            const positions = pendingCursorsRef.current;
            pendingCursorsRef.current = {};
            cursorFrameRef.current = null;
            setSnapshot((current) => ({
              ...current,
              players: current.players.map((player) =>
                positions[player.id]
                  ? { ...player, position: positions[player.id] }
                  : player,
              ),
            }));
          });
        }
      }
      if (message.type === "error") {
        setNotice(message.message);
        window.setTimeout(() => setNotice(null), 2_500);
      }
    }

    const socket = createRoomSocket({
      roomCode,
      role: "host",
      clientId: hostId,
      onStatus: setStatus,
      onMessage: handleMessage,
      onOpen: () => socketRef.current?.send({ type: "request-snapshot" }),
    });
    socketRef.current = socket;
    return () => {
      if (cursorFrameRef.current !== null) {
        window.cancelAnimationFrame(cursorFrameRef.current);
        cursorFrameRef.current = null;
      }
      socket.close();
      socketRef.current = null;
    };
  }, [roomCode]);

  useEffect(() => {
    if (snapshot.phase !== "playing") return;
    const initialTimer = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 50);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [snapshot.phase]);

  useEffect(() => {
    function sendViewport() {
      socketRef.current?.send({
        type: "host-viewport",
        payload: {
          aspectRatio: window.innerWidth / Math.max(1, window.innerHeight),
        },
      });
    }
    window.addEventListener("resize", sendViewport);
    return () => window.removeEventListener("resize", sendViewport);
  }, []);

  async function startGame() {
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // Fullscreen is optional; gameplay still starts.
    }
    socketRef.current?.send({
      type: "host-start",
      payload: {
        aspectRatio: window.innerWidth / Math.max(1, window.innerHeight),
      },
    });
  }

  function updateRoomSettings(payload: {
    powerUpMode?: PowerUpMode;
    maxRounds?: number;
    roundSeconds?: number;
  }) {
    socketRef.current?.send({ type: "host-settings", payload });
  }

  if (!roomCode) return <div className="min-h-dvh bg-[#10120f]" />;

  if (snapshot.phase === "playing") {
    return (
      <GameScreen
        snapshot={snapshot}
        now={now}
        notice={notice}
        onEnd={() => socketRef.current?.send({ type: "host-end" })}
      />
    );
  }

  if (snapshot.phase === "finished") {
    return (
      <ResultsScreen
        players={snapshot.players}
        onReset={() => socketRef.current?.send({ type: "host-reset" })}
      />
    );
  }

  const eligiblePlayers = snapshot.players.filter(
    (player) => player.connected && player.calibrated,
  );
  const calibratingPlayers = snapshot.players.filter(
    (player) => player.connected && !player.calibrated,
  );
  const canStart =
    eligiblePlayers.length >= GAME_CONFIG.minPlayers && status === "connected";

  return (
    <main className="lobby-shell min-h-dvh overflow-hidden bg-[#10120f] text-[#f5f5ec]">
      <div className="landing-grid fixed inset-0 opacity-25" />
      <div className="relative mx-auto flex min-h-dvh max-w-[1440px] flex-col px-6 py-6 sm:px-10 lg:px-14">
        <header className="flex items-center justify-between">
          <CursorTagLogo />
          <ConnectionPill status={status} />
        </header>

        <section className="grid flex-1 items-center gap-8 py-8 lg:grid-cols-[.86fr_1.14fr] lg:gap-12">
          <div>
            <span className="text-xs font-black uppercase tracking-[.22em] text-[#b7ff45]">
              Lobby open
            </span>
            <h1 className="mt-4 text-5xl font-black leading-[.92] tracking-[-.06em] sm:text-7xl">
              GET YOUR
              <br />
              CURSORS IN.
            </h1>
            <p className="mt-5 max-w-lg text-lg font-semibold leading-relaxed text-white/65">
              Scan → pick a color → aim at the center dot.
            </p>

            <div className="mt-8 flex flex-col gap-5 sm:flex-row sm:items-center">
              <div className="rounded-[1.6rem] bg-white p-3 shadow-[0_16px_50px_rgba(0,0,0,.28)]">
                {roomUrl ? (
                  <QRCodeSVG
                    value={roomUrl}
                    size={176}
                    bgColor="#ffffff"
                    fgColor="#10120f"
                    level="M"
                  />
                ) : (
                  <div className="size-44 animate-pulse bg-black/5" />
                )}
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-[.18em] text-white/35">
                  Room code
                </p>
                <p className="mt-1 font-mono text-5xl font-black tracking-[.08em] text-[#b7ff45] sm:text-6xl">
                  {roomCode}
                </p>
                <p className="mt-2 text-sm font-semibold text-white/35">
                  or visit this page and enter the code
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setHowToOpen(true)}
              className="mt-6 inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/[.055] px-4 py-3 text-sm font-black text-white/70 transition hover:bg-white/10 hover:text-white"
            >
              <CircleHelp className="size-4 text-[#b7ff45]" /> How to play
            </button>
          </div>

          <div className="rounded-[2rem] border border-white/10 bg-white/[.055] p-5 shadow-2xl backdrop-blur-sm sm:p-7">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs font-black uppercase tracking-[.18em] text-[#b7ff45]">
                  Live warm-up
                </p>
                <p className="mt-1 text-3xl font-black tracking-[-.04em]">
                  Move around now
                </p>
              </div>
              <span className="flex items-center gap-2 text-sm font-black text-white/45">
                <Users className="size-5 text-[#7c5cff]" />
                {snapshot.players.length} / {snapshot.maxPlayers}
              </span>
            </div>
            <div
              className="mt-4 flex flex-wrap items-center gap-2 border-b border-white/8 pb-4"
              aria-label="Power-up legend"
            >
              <span className="mr-1 text-[11px] font-black uppercase tracking-[.16em] text-[#b7ff45]">
                Power-ups
              </span>
              <PowerUpLegendItem type="boost" />
              <PowerUpLegendItem type="slow" />
              <PowerUpLegendItem type="freeze" />
              <PowerUpLegendItem type="bonus" />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/15 px-3 py-2.5">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[.14em] text-white/35">
                  Game settings
                </p>
                <p className="mt-0.5 text-xs font-bold capitalize text-white/65">
                  {snapshot.maxRounds} rounds · {snapshot.roundSeconds}s each ·
                  Power-ups {snapshot.powerUpMode}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[.07] px-3 py-2 text-[10px] font-black uppercase tracking-[.08em] text-white/70 transition hover:bg-white/12 hover:text-white"
              >
                <SlidersHorizontal className="size-3.5" /> Change
              </button>
            </div>

            <div className="relative mt-5 min-h-72 overflow-hidden rounded-2xl border border-white/8 bg-[#0f110e]">
              <div className="arena-grid absolute inset-0 opacity-35" />
              {eligiblePlayers.length === 0 ? (
                <div className="absolute inset-0 grid place-items-center text-center">
                  <div>
                    <Smartphone className="mx-auto size-8 text-white/20" />
                    <p className="mt-3 font-bold text-white/35">
                      Join and calibrate to try your cursor
                    </p>
                  </div>
                </div>
              ) : (
                eligiblePlayers.map((player) => (
                  <PracticeCursor key={player.id} player={player} />
                ))
              )}
              {snapshot.players.length > 0 && (
                <div className="absolute inset-x-3 bottom-3 flex flex-wrap gap-2">
                  {snapshot.players.map((player) => (
                    <LobbyPlayer key={player.id} player={player} compact />
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              disabled={!canStart}
              onClick={() => void startGame()}
              className="mt-6 flex h-16 w-full items-center justify-center gap-3 rounded-2xl bg-[#b7ff45] text-lg font-black text-[#10120f] shadow-[0_7px_0_#648d20] transition active:translate-y-1 active:shadow-[0_2px_0_#648d20] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/25 disabled:shadow-none"
            >
              {status === "connecting" || status === "reconnecting" ? (
                <LoaderCircle className="size-5 animate-spin" />
              ) : (
                <Play className="size-5 fill-current" />
              )}
              {eligiblePlayers.length < GAME_CONFIG.minPlayers
                ? `Need ${GAME_CONFIG.minPlayers - eligiblePlayers.length} more calibrated`
                : "Start game"}
              {canStart && <Expand className="size-4" />}
            </button>
          </div>
        </section>
      </div>
      {calibratingPlayers.length > 0 && <CalibrationTarget />}
      {settingsOpen && (
        <GameSettingsDialog
          snapshot={snapshot}
          onChange={updateRoomSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {howToOpen && <HowToPlayDialog onClose={() => setHowToOpen(false)} />}
      {notice && <Toast message={notice} />}
    </main>
  );
}

function GameSettingsDialog({
  snapshot,
  onChange,
  onClose,
}: {
  snapshot: RoomSnapshot;
  onChange: (payload: {
    powerUpMode?: PowerUpMode;
    maxRounds?: number;
    roundSeconds?: number;
  }) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/70 p-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="game-settings-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-[1.75rem] border border-white/12 bg-[#191c18] p-5 shadow-[0_30px_100px_rgba(0,0,0,.6)] sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[.16em] text-[#b7ff45]">
              Host controls
            </p>
            <h2
              id="game-settings-title"
              className="mt-1 text-3xl font-black tracking-[-.04em]"
            >
              Game settings
            </h2>
            <p className="mt-1 text-sm font-semibold text-white/45">
              Shared live with everyone in the room.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close game settings"
            className="grid size-10 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[.06] text-white/55 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-6 space-y-4">
          <LobbySetting
            label="Number of rounds"
            value={snapshot.maxRounds}
            options={GAME_CONFIG.roundOptions}
            format={(value) => String(value)}
            onChange={(maxRounds) => onChange({ maxRounds })}
          />
          <LobbySetting
            label="Seconds per round"
            value={snapshot.roundSeconds}
            options={GAME_CONFIG.roundSecondsOptions}
            format={(value) => `${value}s`}
            onChange={(roundSeconds) => onChange({ roundSeconds })}
          />
          <LobbySetting
            label="Power-up frequency"
            value={snapshot.powerUpMode}
            options={["off", "normal", "chaos"] as const}
            format={(value) => value}
            onChange={(powerUpMode) => onChange({ powerUpMode })}
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-7 h-13 w-full rounded-xl bg-[#b7ff45] font-black text-[#10120f] shadow-[0_5px_0_#648d20] active:translate-y-1 active:shadow-none"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function HowToPlayDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-black/75 p-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="how-to-play-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto w-full max-w-4xl rounded-[1.75rem] border border-white/12 bg-[#191c18] p-5 shadow-[0_30px_100px_rgba(0,0,0,.65)] sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[.16em] text-[#b7ff45]">
              Quick visual guide
            </p>
            <h2
              id="how-to-play-title"
              className="mt-1 text-3xl font-black tracking-[-.04em] sm:text-4xl"
            >
              How to play
            </h2>
            <p className="mt-1 text-sm font-semibold text-white/45">
              Move, pass the tag, and finish with the most points.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close how to play"
            className="grid size-10 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[.06] text-white/55 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <VisualRule
            number="1"
            title="Tilt to move"
            detail="Your phone steers your colored cursor."
          >
            <div className="relative grid h-50 place-items-center overflow-hidden rounded-2xl bg-[#0f110e]">
              <span className="absolute size-16 rounded-full border border-[#7c5cff]/25" />
              <Move3d className="size-11 rotate-[-12deg] text-[#9b87ff]" />
              <span className="absolute right-6 top-5 text-lg text-white/25">
                ↗
              </span>
              <span className="absolute bottom-4 left-6 text-lg text-white/25">
                ↙
              </span>
            </div>
          </VisualRule>

          <VisualRule
            number="2"
            title="Pass the tag"
            detail="The star chases and touches another cursor."
          >
            <div className="relative flex h-50 items-center justify-center gap-3 overflow-hidden rounded-2xl bg-[#0f110e]">
              <span className="grid size-12 place-items-center rounded-full border-4 border-white bg-[#ff5c5c] shadow-lg">
                <Star className="size-6 fill-white text-white" />
              </span>
              <span className="text-2xl font-black text-[#b7ff45]">→</span>
              <span className="grid size-12 place-items-center rounded-full border-4 border-white bg-[#44a7ff] shadow-lg">
                <span className="size-1.5 rounded-full bg-white" />
              </span>
            </div>
          </VisualRule>

          <VisualRule
            number="3"
            title="Score points"
            detail="Tag someone or survive until the timer ends."
          >
            <div className="grid h-50 grid-cols-2 gap-px overflow-hidden rounded-2xl bg-white/8">
              <div className="flex flex-col items-center justify-center bg-[#0f110e] text-center">
                <Star className="size-7 fill-[#ff5c5c] text-[#ff5c5c]" />
                <span className="text-xl font-black text-[#b7ff45]">+1</span>
                <span className="text-[9px] font-black uppercase text-white/35">
                  Tag
                </span>
              </div>
              <div className="flex flex-col items-center justify-center bg-[#0f110e] text-center">
                <span className="font-mono text-2xl font-black text-white">
                  00
                </span>
                <span className="text-xl font-black text-[#b7ff45]">+1</span>
                <span className="text-[9px] font-black uppercase text-white/35">
                  Survive
                </span>
              </div>
            </div>
          </VisualRule>

          <VisualRule
            number="4"
            title="Grab power-ups"
            detail="Touch an icon for a temporary advantage."
          >
            <div className="flex h-50 flex-wrap content-center justify-center gap-2 rounded-2xl bg-[#0f110e] px-3">
              <PowerUpLegendItem type="boost" />
              <PowerUpLegendItem type="slow" />
              <PowerUpLegendItem type="freeze" />
              <PowerUpLegendItem type="bonus" />
            </div>
          </VisualRule>
        </div>

        <div className="mt-5 flex flex-col items-center justify-between gap-3 rounded-2xl border border-[#b7ff45]/20 bg-[#b7ff45]/8 px-5 py-4 text-center sm:flex-row sm:text-left">
          <div>
            <p className="text-sm font-black text-[#b7ff45]">
              MOST POINTS WINS
            </p>
            <p className="mt-0.5 text-xs font-semibold text-white/50">
              Nobody is eliminated. Everyone plays every round.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-xl bg-[#b7ff45] px-6 font-black text-[#10120f] shadow-[0_4px_0_#648d20] active:translate-y-1 active:shadow-none"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function VisualRule({
  number,
  title,
  detail,
  children,
}: {
  number: string;
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <article className="rounded-2xl border border-white/10 bg-white/[.045] p-3">
      {children}
      <div className="mt-3 flex items-start gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#b7ff45] font-mono text-[10px] font-black text-[#10120f]">
          {number}
        </span>
        <div>
          <h3 className="text-sm font-black">{title}</h3>
          <p className="mt-0.5 text-xs font-semibold leading-snug text-white/40">
            {detail}
          </p>
        </div>
      </div>
    </article>
  );
}

function CalibrationTarget() {
  return (
    <div
      className="calibration-target pointer-events-none fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 text-center"
      role="status"
      aria-label="Calibration target at the center of the screen"
    >
      <div className="relative mx-auto grid size-12 place-items-center rounded-full border border-[#b7ff45]/65 bg-[#10120f]/75 shadow-[0_0_22px_rgba(183,255,69,.25)] backdrop-blur-sm">
        <span className="absolute h-px w-16 bg-[#b7ff45]/35" />
        <span className="absolute h-16 w-px bg-[#b7ff45]/35" />
        <span className="size-2.5 rounded-full bg-[#b7ff45] shadow-[0_0_10px_#b7ff45]" />
      </div>
      <span className="mt-2 block text-[9px] font-black uppercase tracking-[.16em] text-[#b7ff45]/55">
        Center
      </span>
    </div>
  );
}

function LobbySetting<T extends string | number>({
  label,
  value,
  options,
  format,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  format: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-black uppercase tracking-[.12em] text-white/40">
        {label}
      </p>
      <div className="flex rounded-lg border border-white/8 bg-black/25 p-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={value === option}
            className={`flex-1 rounded-md px-2 py-1.5 font-black uppercase transition ${value === option ? "bg-[#b7ff45] text-[#10120f]" : "text-white/40 hover:text-white/75"}`}
          >
            {format(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

function PracticeCursor({ player }: { player: RoomPlayer }) {
  return (
    <div
      className="practice-cursor pointer-events-none absolute z-10"
      style={{
        left: `${player.position.x * 100}%`,
        top: `${player.position.y * 100}%`,
      }}
    >
      <span
        className="absolute bottom-12 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-[10px] font-black text-[#10120f]"
        style={{ backgroundColor: player.color }}
      >
        {player.name}
      </span>
      <span
        className="grid size-10 place-items-center rounded-full border-4 border-white shadow-xl"
        style={{ backgroundColor: player.color }}
      >
        <span className="size-1.5 rounded-full bg-white" />
      </span>
    </div>
  );
}

function GameScreen({
  snapshot,
  now,
  notice,
  onEnd,
}: {
  snapshot: RoomSnapshot;
  now: number;
  notice: string | null;
  onEnd: () => void;
}) {
  const itPlayer = snapshot.players.find(
    (player) => player.id === snapshot.itPlayerId,
  );
  const remaining = snapshot.roundEndsAt
    ? Math.max(0, snapshot.roundEndsAt - now)
    : 0;
  const seconds = (remaining / 1_000).toFixed(1).padStart(4, "0");
  const danger = remaining > 0 && remaining <= 5_000;
  const paused = !itPlayer || !snapshot.roundEndsAt;
  const readyPlayers = snapshot.players.filter(
    (player) => player.connected && player.calibrated && !player.eliminated,
  ).length;
  const recentPowerUp =
    snapshot.powerUpEvent && now - snapshot.powerUpEvent.at < 1_200
      ? snapshot.powerUpEvent
      : null;
  const powerUpPlayer = recentPowerUp
    ? snapshot.players.find((player) => player.id === recentPowerUp.playerId)
    : null;

  return (
    <main className="game-screen relative h-dvh cursor-none overflow-hidden bg-[#0d0f0c] text-white">
      <div className="arena-grid absolute inset-0 opacity-30" />
      <div
        className={`timer-wash absolute inset-x-0 top-0 h-[42%] ${danger ? "danger" : ""}`}
      />
      <div className="pointer-events-none absolute left-8 top-7 z-20 text-xs font-black uppercase tracking-[.22em] text-white/25">
        Round {String(snapshot.round).padStart(2, "0")} / {snapshot.maxRounds}
      </div>
      <div className="pointer-events-none absolute right-8 top-7 z-20 flex items-center gap-2 text-xs font-black uppercase tracking-[.18em] text-white/25">
        <span className="size-1.5 rounded-full bg-[#b7ff45]" /> {readyPlayers}{" "}
        ready
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-5 z-10 text-center">
        <p
          className={`font-mono font-black leading-none tracking-[-.09em] tabular-nums ${
            paused
              ? "text-[clamp(4rem,10vw,8rem)] text-white/28"
              : `text-[clamp(5.6rem,13vw,11rem)] ${danger ? "timer-danger text-[#ff5c5c]" : "text-[#f5f5ec]"}`
          }`}
        >
          {paused ? "PAUSED" : seconds}
        </p>
        <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-[#ff5c5c]/30 bg-[#ff5c5c]/12 px-4 py-2 text-sm font-black uppercase tracking-[.12em] text-[#ff8585]">
          <span className="size-2 animate-pulse rounded-full bg-[#ff5c5c]" />
          {itPlayer
            ? `${itPlayer.name} is it`
            : "Waiting for two ready players"}
        </div>
      </div>

      {snapshot.powerUps.map((powerUp) => (
        <ArenaPowerUpView key={powerUp.id} powerUp={powerUp} />
      ))}
      {snapshot.players.map((player) => (
        <LiveCursor
          key={player.id}
          player={player}
          isIt={player.id === snapshot.itPlayerId}
          frozen={Boolean(
            snapshot.freezeUntil &&
            now < snapshot.freezeUntil &&
            snapshot.frozenPlayerIds.includes(player.id),
          )}
          protectedFromTag={Boolean(
            (snapshot.protectedPlayerId === player.id &&
              snapshot.invulnerableUntil &&
              now < snapshot.invulnerableUntil) ||
            (player.shieldUntil && now < player.shieldUntil),
          )}
          movementModifier={
            player.movementModifierUntil && now < player.movementModifierUntil
              ? player.movementModifier
              : null
          }
        />
      ))}

      {recentPowerUp && powerUpPlayer && (
        <PowerUpToast
          type={recentPowerUp.type}
          playerName={powerUpPlayer.name}
        />
      )}

      <div className="pointer-events-none absolute bottom-6 left-6 z-10 flex max-w-[75vw] flex-wrap gap-2">
        {snapshot.players.map((player) => (
          <div
            key={player.id}
            className="flex items-center gap-2 rounded-xl border border-white/8 bg-black/35 px-3 py-2 text-xs backdrop-blur"
          >
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: player.color }}
            />
            <strong>{player.name}</strong>
            <span className="font-mono font-black text-[#b7ff45]">
              {player.score} pts
            </span>
          </div>
        ))}
      </div>

      {snapshot.impact && now - snapshot.impact.at < 900 && (
        <div
          key={snapshot.impact.id}
          className="impact-burst pointer-events-none absolute z-30"
          style={{
            left: `${snapshot.impact.x * 100}%`,
            top: `${snapshot.impact.y * 100}%`,
          }}
        >
          <span />
          <span />
          <span />
          <strong>TAG!</strong>
        </div>
      )}

      <button
        type="button"
        onClick={onEnd}
        className="host-end-control absolute bottom-5 right-5 z-50 cursor-pointer rounded-full border border-white/10 bg-black/30 px-4 py-2 text-xs font-bold text-white/45 opacity-0 transition hover:opacity-100 focus:opacity-100"
      >
        End game
      </button>
      {notice && <Toast message={notice} />}
    </main>
  );
}

const POWER_UP_STYLE: Record<
  PowerUpType,
  { label: string; className: string }
> = {
  shield: {
    label: "Shield",
    className:
      "border-[#b7ff45] bg-[#b7ff45] text-[#10120f] shadow-[0_0_28px_rgba(183,255,69,.7)]",
  },
  boost: {
    label: "Turbo",
    className:
      "border-[#b7ff45] bg-[#b7ff45] text-[#10120f] shadow-[0_0_28px_rgba(183,255,69,.7)]",
  },
  slow: {
    label: "Slow field",
    className:
      "border-[#ff9f43] bg-[#ff9f43] text-[#241302] shadow-[0_0_28px_rgba(255,159,67,.7)]",
  },
  freeze: {
    label: "Freeze",
    className:
      "border-[#70dcff] bg-[#70dcff] text-[#0b2530] shadow-[0_0_28px_rgba(112,220,255,.7)]",
  },
  bonus: {
    label: "+2",
    className:
      "border-[#ffbe3d] bg-[#ffbe3d] text-[#2a1b00] shadow-[0_0_28px_rgba(255,190,61,.7)]",
  },
};

function PowerUpIcon({
  type,
  className = "size-5",
}: {
  type: PowerUpType;
  className?: string;
}) {
  if (type === "shield") return <ShieldCheck className={className} />;
  if (type === "boost") return <Zap className={className} />;
  if (type === "slow") return <Snail className={className} />;
  if (type === "freeze") return <Snowflake className={className} />;
  return <Sparkles className={className} />;
}

function PowerUpLegendItem({ type }: { type: Exclude<PowerUpType, "shield"> }) {
  const style = POWER_UP_STYLE[type];
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[.07] px-3 py-2 text-xs font-black uppercase tracking-[.08em] text-white/75">
      <PowerUpIcon type={type} className="size-4 text-white" />
      {style.label}
    </span>
  );
}

function ArenaPowerUpView({ powerUp }: { powerUp: ArenaPowerUp }) {
  const style = POWER_UP_STYLE[powerUp.type];
  return (
    <div
      className="arena-power-up pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 text-center"
      style={{ left: `${powerUp.x * 100}%`, top: `${powerUp.y * 100}%` }}
      role="img"
      aria-label={`${style.label} power-up`}
      title={style.label}
    >
      <span
        className={`grid size-13 place-items-center rounded-full border-4 border-white ${style.className}`}
      >
        <PowerUpIcon type={powerUp.type} className="size-6" />
      </span>
    </div>
  );
}

function PowerUpToast({
  type,
  playerName,
}: {
  type: PowerUpType;
  playerName: string;
}) {
  return (
    <div className="power-up-toast pointer-events-none absolute left-1/2 top-[30%] z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-[#10120f]/92 px-5 py-3 text-sm font-black uppercase tracking-[.1em] text-white shadow-2xl backdrop-blur">
      <PowerUpIcon type={type} className="size-5 text-[#b7ff45]" /> {playerName}{" "}
      grabbed {POWER_UP_STYLE[type].label}
    </div>
  );
}

function LiveCursor({
  player,
  isIt,
  frozen,
  protectedFromTag,
  movementModifier,
}: {
  player: RoomPlayer;
  isIt: boolean;
  frozen: boolean;
  protectedFromTag: boolean;
  movementModifier: RoomPlayer["movementModifier"];
}) {
  return (
    <div
      className={`live-cursor pointer-events-none absolute left-0 top-0 z-20 ${isIt ? "is-it" : ""} ${player.connected ? "" : "is-disconnected"} ${frozen ? "is-frozen" : ""} ${protectedFromTag ? "is-protected" : ""}`}
      style={{
        transform: `translate3d(calc(${player.position.x * 100}vw - 28px), calc(${player.position.y * 100}vh - 28px), 0)`,
      }}
    >
      <div
        className="cursor-name absolute bottom-[66px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-black text-[#0f110e] shadow-xl"
        style={{ backgroundColor: player.color }}
      >
        {player.name}
        {isIt ? " · IT" : ""}
        {!player.connected ? " · OFFLINE" : ""}
      </div>
      <div
        className="cursor-orb relative grid size-14 place-items-center rounded-full border-[5px] border-[#f8f8ef] shadow-[0_8px_30px_rgba(0,0,0,.35)]"
        style={{ backgroundColor: player.color }}
        role="img"
        aria-label={isIt ? `${player.name} is it` : `${player.name}'s cursor`}
      >
        {isIt ? (
          <Star className="size-7 fill-white text-white" strokeWidth={2.5} />
        ) : (
          <span className="size-2 rounded-full bg-white" />
        )}
        {protectedFromTag && (
          <span className="absolute -right-3 -top-3 grid size-6 place-items-center rounded-full bg-[#b7ff45] text-[#10120f] shadow-lg">
            <ShieldCheck className="size-3.5" />
          </span>
        )}
        {movementModifier && (
          <span
            className={`absolute -bottom-4 left-1/2 grid size-6 -translate-x-1/2 place-items-center rounded-full shadow-lg ${movementModifier === "boost" ? "bg-[#b7ff45] text-[#10120f]" : "bg-[#ff9f43] text-[#241302]"}`}
            role="img"
            aria-label={
              movementModifier === "boost" ? "Turbo active" : "Slow active"
            }
          >
            {movementModifier === "boost" ? (
              <Zap className="size-3.5" />
            ) : (
              <Snail className="size-3.5" />
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function LobbyPlayer({
  player,
  compact = false,
}: {
  player: RoomPlayer;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div
        className={`flex items-center gap-2 rounded-lg border border-white/8 bg-black/65 px-2.5 py-1.5 text-[10px] font-black backdrop-blur ${player.connected ? "" : "opacity-45"}`}
      >
        <span
          className="size-2.5 rounded-full"
          style={{ backgroundColor: player.color }}
        />
        <span>{player.name}</span>
        <span
          className={player.calibrated ? "text-[#b7ff45]" : "text-white/35"}
        >
          {player.calibrated ? "Ready" : "Calibrating"}
        </span>
      </div>
    );
  }
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${player.connected ? "border-white/8 bg-black/15" : "border-white/5 bg-black/10 opacity-45"}`}
    >
      <span
        className="grid size-11 shrink-0 place-items-center rounded-xl text-lg font-black text-[#10120f]"
        style={{ backgroundColor: player.color }}
      >
        {player.name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-black">{player.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] font-bold text-white/35">
          {!player.connected ? (
            <>
              <WifiOff className="size-3" /> Reconnecting · removes in 10s
            </>
          ) : player.calibrated ? (
            <>
              <Check className="size-3 text-[#b7ff45]" /> Ready
            </>
          ) : (
            <>
              <LoaderCircle className="size-3 animate-spin" /> Calibrating
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function ResultsScreen({
  players,
  onReset,
}: {
  players: RoomPlayer[];
  onReset: () => void;
}) {
  const ranked = useMemo(
    () => [...players].sort((a, b) => b.score - a.score),
    [players],
  );
  return (
    <main className="results-shell min-h-dvh bg-[#10120f] px-6 py-10 text-[#f5f5ec]">
      <div className="landing-grid fixed inset-0 opacity-20" />
      <div className="relative mx-auto max-w-3xl text-center">
        <Trophy className="mx-auto size-12 text-[#b7ff45]" />
        <p className="mt-5 text-xs font-black uppercase tracking-[.22em] text-[#b7ff45]">
          Game over
        </p>
        <h1 className="mt-3 text-6xl font-black tracking-[-.06em] sm:text-8xl">
          FINAL CHASE
        </h1>
        <div className="mt-9 overflow-hidden rounded-[2rem] border border-white/10 bg-white/[.05] text-left">
          {ranked.map((player, index) => (
            <div
              key={player.id}
              className="flex items-center gap-4 border-b border-white/8 px-5 py-4 last:border-0 sm:px-7"
            >
              <span className="w-8 font-mono text-xl font-black text-white/25">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                className="size-4 rounded-full"
                style={{ backgroundColor: player.color }}
              />
              <strong className="flex-1 text-xl">{player.name}</strong>
              <span className="text-xs font-black uppercase tracking-[.12em] text-white/35">
                points
              </span>
              <span className="w-14 text-right font-mono text-2xl font-black tabular-nums text-[#b7ff45]">
                {player.score}
              </span>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onReset}
          className="mt-8 inline-flex h-14 items-center gap-2 rounded-2xl bg-[#b7ff45] px-7 font-black text-[#10120f] shadow-[0_6px_0_#648d20] active:translate-y-1 active:shadow-[0_2px_0_#648d20]"
        >
          <RotateCcw className="size-4" /> Back to lobby
        </button>
      </div>
    </main>
  );
}

function ConnectionPill({ status }: { status: RoomConnectionStatus }) {
  const connected = status === "connected";
  return (
    <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[.04] px-3 py-2 text-xs font-bold text-white/50">
      {status === "connecting" || status === "reconnecting" ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : connected ? (
        <span className="size-2 rounded-full bg-[#b7ff45]" />
      ) : (
        <CircleAlert className="size-3.5 text-[#ff5c5c]" />
      )}
      {connected
        ? "Realtime ready"
        : status === "error"
          ? "Realtime not configured"
          : "Connecting"}
    </span>
  );
}

function Toast({ message }: { message: string }) {
  return (
    <div className="pointer-events-none fixed bottom-7 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-white/12 bg-[#171a16]/95 px-5 py-3 text-sm font-black text-white shadow-2xl backdrop-blur">
      <X className="size-4 text-[#ff5c5c]" />
      {message}
    </div>
  );
}
