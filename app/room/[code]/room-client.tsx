"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CircleAlert,
  Crosshair,
  Eye,
  Heart,
  LoaderCircle,
  Move3d,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Trophy,
  UserRound,
  Wifi,
  WifiOff,
} from "lucide-react";

import { CursorTagLogo } from "@/components/cursor-tag-logo";
import { GAME_CONFIG } from "@/lib/game/config";
import {
  AIR_MOUSE_CONFIG,
  calculateAirMouseAim,
  type AirMouseOrientation,
} from "@/lib/input/airmouse";
import { createRoomSocket, type RoomConnectionStatus, type RoomSocket } from "@/lib/realtime/room";
import type { RoomSnapshot, ServerRoomMessage } from "@/lib/realtime/types";

type SensorStatus = "idle" | "requesting" | "active" | "denied" | "unsupported";
type PermissionCapableOrientation = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

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
    maxPlayers: GAME_CONFIG.maxPlayers,
    maxLives: GAME_CONFIG.startingLives,
    maxRounds: GAME_CONFIG.maxRounds,
    collisionRadius: GAME_CONFIG.collisionRadius,
  };
}

function getPlayerId(roomCode: string) {
  const key = `cursor-tag-player-${roomCode}`;
  const stored = sessionStorage.getItem(key);
  if (stored) return stored;
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return id;
}

export default function RoomClient({ roomCode }: { roomCode: string }) {
  const [status, setStatus] = useState<RoomConnectionStatus>("connecting");
  const [snapshot, setSnapshot] = useState<RoomSnapshot>(emptySnapshot);
  const [playerId, setPlayerId] = useState("");
  const [nickname, setNickname] = useState("");
  const [joined, setJoined] = useState(false);
  const [calibrated, setCalibrated] = useState(false);
  const [sensorStatus, setSensorStatus] = useState<SensorStatus>("idle");
  const [hasReading, setHasReading] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<RoomSocket | null>(null);
  const joinedRef = useRef(false);
  const nicknameRef = useRef("");
  const currentReadingRef = useRef<AirMouseOrientation | null>(null);
  const originRef = useRef<AirMouseOrientation | null>(null);
  const smoothedAimRef = useRef({ x: 0, y: 0 });
  const lastSentAimRef = useRef({ x: Number.NaN, y: Number.NaN });
  const lastSentAtRef = useRef(0);
  const sequenceRef = useRef(0);
  const calibratedRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  const hasReadingRef = useRef(false);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    const id = getPlayerId(roomCode);
    const storedName = localStorage.getItem("cursor-tag-nickname") ?? "";
    const wasJoined = sessionStorage.getItem(`cursor-tag-joined-${roomCode}`) === "true";
    nicknameRef.current = storedName;
    joinedRef.current = wasJoined;
    const hydrationTimer = window.setTimeout(() => {
      setPlayerId(id);
      setNickname(storedName);
      setJoined(wasJoined);
    }, 0);

    function handleMessage(message: ServerRoomMessage) {
      if (message.type === "connected") {
        setSnapshot(message.payload.snapshot);
        if (message.payload.snapshot.phase === "playing") setNow(Date.now());
      }
      if (message.type === "snapshot" || message.type === "tag") {
        setSnapshot(message.payload);
        if (message.payload.phase === "playing") setNow(Date.now());
      }
      if (message.type === "timeout") {
        setSnapshot(message.payload.snapshot);
        setNow(Date.now());
      }
      if (message.type === "pong") {
        setLatencyMs(Math.max(0, Math.round(performance.now() - message.payload.clientSentAt)));
      }
      if (message.type === "error") setError(message.message);
    }

    const socket = createRoomSocket({
      roomCode,
      role: "player",
      clientId: id,
      onStatus: setStatus,
      onMessage: handleMessage,
      onOpen: () => {
        if (joinedRef.current && nicknameRef.current) {
          socketRef.current?.send({ type: "join", payload: { name: nicknameRef.current } });
        }
        socketRef.current?.send({ type: "request-snapshot" });
      },
    });
    socketRef.current = socket;

    return () => {
      window.clearTimeout(hydrationTimer);
      socket.close();
      socketRef.current = null;
    };
  }, [roomCode]);

  useEffect(() => {
    if (!snapshot.invulnerableUntil || snapshot.phase !== "playing") return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [snapshot.invulnerableUntil, snapshot.phase]);

  useEffect(() => {
    if (sensorStatus !== "active") return;

    function handleOrientation(event: DeviceOrientationEvent) {
      if (typeof event.alpha !== "number" || typeof event.beta !== "number") return;
      const current = { alpha: event.alpha, beta: event.beta };
      currentReadingRef.current = current;
      if (!hasReadingRef.current) {
        hasReadingRef.current = true;
        setHasReading(true);
      }

      const origin = originRef.current;
      if (!origin || !calibratedRef.current || snapshotRef.current.phase !== "playing") return;
      const next = calculateAirMouseAim(
        current,
        origin,
        smoothedAimRef.current,
      );
      smoothedAimRef.current = next;

      const sentAt = performance.now();
      if (
        sentAt - lastSentAtRef.current <
        AIR_MOUSE_CONFIG.sendIntervalMs
      ) {
        return;
      }
      const last = lastSentAimRef.current;
      if (
        Math.abs(next.x - last.x) < AIR_MOUSE_CONFIG.aimChangeThreshold &&
        Math.abs(next.y - last.y) < AIR_MOUSE_CONFIG.aimChangeThreshold
      ) {
        return;
      }

      lastSentAtRef.current = sentAt;
      lastSentAimRef.current = next;
      sequenceRef.current += 1;
      socketRef.current?.send({
        type: "cursor",
        payload: {
          x: (next.x + 1) / 2,
          y: (next.y + 1) / 2,
          sequence: sequenceRef.current,
          clientSentAt: sentAt,
        },
      });
    }

    window.addEventListener("deviceorientation", handleOrientation, { passive: true });
    return () => window.removeEventListener("deviceorientation", handleOrientation);
  }, [sensorStatus]);

  async function requestMotionAccess() {
    if (typeof DeviceOrientationEvent === "undefined") {
      setSensorStatus("unsupported");
      return false;
    }
    setSensorStatus("requesting");
    try {
      const orientation = DeviceOrientationEvent as PermissionCapableOrientation;
      if (typeof orientation.requestPermission === "function") {
        const permission = await orientation.requestPermission();
        if (permission !== "granted") {
          setSensorStatus("denied");
          return false;
        }
      }
      setSensorStatus("active");
      return true;
    } catch {
      setSensorStatus("denied");
      return false;
    }
  }

  async function joinRoom(event: FormEvent) {
    event.preventDefault();
    const cleanName = nickname.trim().replace(/\s+/g, " ").slice(0, 18);
    if (!cleanName || status !== "connected") return;
    const granted = await requestMotionAccess();
    if (!granted) return;
    nicknameRef.current = cleanName;
    joinedRef.current = true;
    setNickname(cleanName);
    setJoined(true);
    localStorage.setItem("cursor-tag-nickname", cleanName);
    sessionStorage.setItem(`cursor-tag-joined-${roomCode}`, "true");
    socketRef.current?.send({ type: "join", payload: { name: cleanName } });
  }

  async function enableMotionAgain() {
    await requestMotionAccess();
  }

  async function calibrate() {
    const reading = currentReadingRef.current;
    if (!reading) return;
    originRef.current = reading;
    smoothedAimRef.current = { x: 0, y: 0 };
    lastSentAimRef.current = { x: Number.NaN, y: Number.NaN };
    lastSentAtRef.current = 0;
    calibratedRef.current = true;
    setCalibrated(true);
    socketRef.current?.send({ type: "calibrated" });
    try {
      const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<unknown> } }).wakeLock;
      await wakeLock?.request("screen");
    } catch {
      // Screen Wake Lock is a convenience, not a gameplay requirement.
    }
  }

  const player = snapshot.players.find((candidate) => candidate.id === playerId);
  const isIt = snapshot.itPlayerId === playerId;
  const isProtected = Boolean(
    isIt &&
      snapshot.protectedPlayerId === playerId &&
      snapshot.invulnerableUntil &&
      now < snapshot.invulnerableUntil,
  );

  if (!joined) {
    return (
      <PhoneShell roomCode={roomCode} status={status} latencyMs={latencyMs}>
        <div className="flex flex-1 flex-col justify-center py-8">
          <span className="phone-eyebrow">Room {roomCode}</span>
          <h1 className="mt-4 text-5xl font-black leading-[.92] tracking-[-.06em]">PICK A NAME.<br /><span className="text-[#6f50ea]">JOIN THE CHASE.</span></h1>
          <p className="mt-5 text-base leading-relaxed text-[#6c6d67]">Your browser will ask for motion access. That turns your phone into the controller.</p>
          <form onSubmit={joinRoom} className="mt-8 rounded-[1.75rem] border border-black/8 bg-white p-5 shadow-[0_20px_70px_rgba(30,32,25,.1)]">
            <label htmlFor="nickname" className="text-sm font-black">Your name</label>
            <div className="mt-2 flex h-14 items-center rounded-2xl bg-[#f0f0e9] px-4 focus-within:ring-4 focus-within:ring-[#7c5cff]/15">
              <UserRound className="size-5 text-black/35" />
              <input id="nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={18} autoComplete="nickname" placeholder="e.g. Speedy Sam" className="min-w-0 flex-1 bg-transparent px-3 font-bold outline-none placeholder:text-black/25" />
            </div>
            <button type="submit" disabled={!nickname.trim() || status !== "connected" || !snapshot.hostConnected || sensorStatus === "requesting"} className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#171914] font-black text-white shadow-[0_6px_0_#74766e] active:translate-y-1 active:shadow-[0_2px_0_#74766e] disabled:bg-black/10 disabled:text-black/30 disabled:shadow-none">
              {sensorStatus === "requesting" ? <LoaderCircle className="size-5 animate-spin" /> : <Move3d className="size-5" />}
              {sensorStatus === "requesting" ? "Requesting motion…" : !snapshot.hostConnected ? "Waiting for host" : "Enable motion & join"}
              {sensorStatus !== "requesting" && <ArrowRight className="size-4" />}
            </button>
            {(sensorStatus === "denied" || sensorStatus === "unsupported") && <MotionError status={sensorStatus} />}
            {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p>}
          </form>
        </div>
      </PhoneShell>
    );
  }

  if (sensorStatus !== "active" || !calibrated) {
    return (
      <PhoneShell roomCode={roomCode} status={status} latencyMs={latencyMs} color={player?.color}>
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <div className="relative grid size-28 place-items-center rounded-[2.3rem] bg-[#7c5cff] text-white shadow-[0_18px_55px_rgba(124,92,255,.3)]">
            <Smartphone className="size-12 calibration-phone" />
            <span className="absolute -right-2 -top-2 grid size-9 place-items-center rounded-full border-4 border-[#f2f1e9] bg-[#b7ff45] text-[#10120f]"><Crosshair className="size-4" /></span>
          </div>
          <span className="phone-eyebrow mt-8">One quick setup</span>
          <h1 className="mt-3 text-4xl font-black leading-[.96] tracking-[-.055em]">HOLD STILL.<br />SET NEUTRAL.</h1>
          <p className="mt-4 max-w-xs text-[#6c6d67]">Hold the phone comfortably, aimed at the middle of the big screen. Small hand tremors will be ignored.</p>
          {sensorStatus !== "active" ? (
            <button type="button" onClick={() => void enableMotionAgain()} className="mt-8 flex h-15 w-full items-center justify-center gap-2 rounded-2xl bg-[#171914] font-black text-white"><Move3d className="size-5" /> Enable motion</button>
          ) : (
            <button type="button" onClick={() => void calibrate()} disabled={!hasReading} className="mt-8 flex h-15 w-full items-center justify-center gap-2 rounded-2xl bg-[#b7ff45] font-black text-[#10120f] shadow-[0_7px_0_#789f35] active:translate-y-1 active:shadow-[0_2px_0_#789f35] disabled:opacity-40 disabled:shadow-none">
              {hasReading ? <Crosshair className="size-5" /> : <LoaderCircle className="size-5 animate-spin" />}
              {hasReading ? "Set neutral position" : "Reading sensors…"}
            </button>
          )}
          {(sensorStatus === "denied" || sensorStatus === "unsupported") && <MotionError status={sensorStatus} />}
        </div>
      </PhoneShell>
    );
  }

  if (snapshot.phase === "finished") {
    return (
      <PhoneShell roomCode={roomCode} status={status} latencyMs={latencyMs} color={player?.color}>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <Trophy className="size-16 text-[#6f50ea]" />
          <span className="phone-eyebrow mt-6">Game over</span>
          <h1 className="mt-3 text-5xl font-black tracking-[-.06em]">{player?.lives ?? 0} LIVES</h1>
          <p className="mt-2 font-mono text-sm font-black text-[#6f50ea]">{player?.score ?? 0} points</p>
          <p className="mt-3 text-[#6c6d67]">Check the big screen for the final ranking.</p>
        </div>
      </PhoneShell>
    );
  }

  if (snapshot.phase === "playing" && player?.eliminated) {
    return (
      <PhoneShell roomCode={roomCode} status={status} latencyMs={latencyMs} color={player.color}>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="grid size-24 place-items-center rounded-[2rem] bg-[#171914] text-white"><Eye className="size-10" /></div>
          <span className="phone-eyebrow mt-7">No lives left</span>
          <h1 className="mt-3 text-5xl font-black tracking-[-.06em]">YOU’RE OUT.</h1>
          <p className="mt-4 max-w-xs text-[#6c6d67]">Your cursor is no longer taggable. Keep watching the chase on the big screen.</p>
        </div>
      </PhoneShell>
    );
  }

  if (snapshot.phase === "lobby" || !snapshot.itPlayerId) {
    return (
      <PhoneShell roomCode={roomCode} status={status} latencyMs={latencyMs} color={player?.color}>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="grid size-24 place-items-center rounded-[2rem] text-4xl font-black text-[#10120f] shadow-xl" style={{ backgroundColor: player?.color ?? "#b7ff45" }}>{nickname.charAt(0).toUpperCase()}</div>
          <span className="phone-eyebrow mt-7">Calibrated & ready</span>
          <h1 className="mt-3 text-4xl font-black tracking-[-.05em]">YOU’RE IN, {nickname.toUpperCase()}.</h1>
          <p className="mt-4 max-w-xs text-[#6c6d67]">Keep this page open. Your cursor will appear when the host starts.</p>
          <div className="mt-7 flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-black shadow-sm"><LoaderCircle className="size-4 animate-spin text-[#6f50ea]" /> Waiting for the host</div>
        </div>
      </PhoneShell>
    );
  }

  return (
    <PhoneShell roomCode={roomCode} status={status} latencyMs={latencyMs} color={player?.color}>
      <div className="flex flex-1 flex-col py-6">
        <div className={`relative flex flex-1 flex-col items-center justify-center overflow-hidden rounded-[2.25rem] border text-center shadow-xl ${isIt ? "border-[#ff5c5c]/30 bg-[#ff5c5c] text-white" : "border-black/5 bg-white text-[#171914]"}`}>
          <div className="controller-rings absolute inset-0 opacity-25" />
          <div className="relative grid size-28 place-items-center rounded-full border-[8px] border-white shadow-[0_16px_45px_rgba(0,0,0,.2)]" style={{ backgroundColor: player?.color ?? "#b7ff45" }}><span className="size-3 rounded-full bg-white" /></div>
          <div className="relative mt-8 flex gap-1" aria-label={`${player?.lives ?? 0} lives`}>
            {Array.from({ length: snapshot.maxLives }, (_, index) => <Heart key={index} className={`size-5 ${index < (player?.lives ?? 0) ? "fill-current" : "opacity-20"}`} />)}
          </div>
          <p className={`relative mt-3 text-xs font-black uppercase tracking-[.22em] ${isIt ? "text-white/65" : "text-black/35"}`}>Round {snapshot.round} / {snapshot.maxRounds}</p>
          <h1 className="relative mt-2 text-5xl font-black leading-[.9] tracking-[-.06em]">{isProtected ? "GET READY" : isIt ? "YOU’RE IT!" : "KEEP MOVING"}</h1>
          <p className={`relative mt-4 max-w-[270px] text-sm font-semibold leading-relaxed ${isIt ? "text-white/75" : "text-black/48"}`}>{isProtected ? "Your shield prevents an instant re-tag. Move clear!" : isIt ? "Tilt to chase another cursor before time runs out." : "Dodge the glowing red cursor. Don’t get tagged."}</p>
          {isProtected && <span className="relative mt-5 inline-flex items-center gap-2 rounded-full bg-white/18 px-4 py-2 text-xs font-black uppercase tracking-[.12em]"><ShieldCheck className="size-4" /> Tag shield</span>}
        </div>
        <button type="button" onClick={() => { calibratedRef.current = false; setCalibrated(false); originRef.current = null; }} className="mt-4 flex h-13 items-center justify-center gap-2 rounded-2xl border border-black/8 bg-white/60 text-sm font-black text-black/55 active:scale-[.98]"><RotateCcw className="size-4" /> Recalibrate neutral</button>
      </div>
    </PhoneShell>
  );
}

function PhoneShell({ roomCode, status, latencyMs, color, children }: { roomCode: string; status: RoomConnectionStatus; latencyMs: number | null; color?: string; children: React.ReactNode }) {
  return (
    <main className="phone-shell min-h-dvh overflow-hidden bg-[#f2f1e9] px-4 text-[#171914]">
      <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col">
        <header className="flex h-17 items-center justify-between border-b border-black/[.06]">
          <CursorTagLogo />
          <div className="flex items-center gap-2">
            {latencyMs !== null && <span className={`rounded-full px-2.5 py-1.5 font-mono text-[10px] font-black ${latencyMs <= 80 ? "bg-[#def7c3] text-[#416719]" : latencyMs <= 140 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}`}>{latencyMs}ms</span>}
            <span className="flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1.5 font-mono text-[10px] font-black tracking-[.1em] shadow-sm">{status === "connected" ? <Wifi className="size-3" style={{ color: color ?? "#6f50ea" }} /> : <WifiOff className="size-3 text-red-500" />}{roomCode}</span>
          </div>
        </header>
        {children}
      </div>
    </main>
  );
}

function MotionError({ status }: { status: SensorStatus }) {
  return <div className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-left text-xs font-bold leading-relaxed text-red-700"><CircleAlert className="mt-0.5 size-4 shrink-0" />{status === "unsupported" ? "This browser does not expose motion sensors. Open the link in Safari on iPhone or Chrome on Android." : "Motion access was denied. Allow Motion & Orientation in your browser settings, then try again."}</div>;
}
