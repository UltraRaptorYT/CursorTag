"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  CircleDot,
  LoaderCircle,
  Move3d,
  RotateCcw,
  ShieldCheck,
  Snail,
  Smartphone,
  Star,
  Trophy,
  UserRound,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";

import { CursorTagLogo } from "@/components/cursor-tag-logo";
import {
  DEFAULT_PLAYER_HUE,
  GAME_CONFIG,
  LEGACY_STARTING_LIVES,
  POWER_UP_CONFIG,
  normalizePlayerHue,
  playerColorFromHue,
} from "@/lib/game/config";
import {
  AIR_MOUSE_CONFIG,
  calculateAirMouseAim,
  type AirMouseOrientation,
} from "@/lib/input/airmouse";
import { createRoomSocket, type RoomConnectionStatus, type RoomSocket } from "@/lib/realtime/room";
import { normalizeRoomSnapshot, type RoomSnapshot, type ServerRoomMessage } from "@/lib/realtime/types";

type SensorStatus = "idle" | "requesting" | "active" | "denied" | "unsupported";
type CalibrationStep = "aim" | "steady" | "done";
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
  const [playerHue, setPlayerHue] = useState(DEFAULT_PLAYER_HUE);
  const [joined, setJoined] = useState(false);
  const [calibrated, setCalibrated] = useState(false);
  const [sensorStatus, setSensorStatus] = useState<SensorStatus>("idle");
  const [hasReading, setHasReading] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [neutralReset, setNeutralReset] = useState(false);
  const [roomUnavailable, setRoomUnavailable] = useState(false);
  const [calibrationStep, setCalibrationStep] = useState<CalibrationStep>("aim");
  const [calibrationCountdown, setCalibrationCountdown] = useState(3);

  const socketRef = useRef<RoomSocket | null>(null);
  const playerIdRef = useRef("");
  const joinedRef = useRef(false);
  const nicknameRef = useRef("");
  const playerHueRef = useRef(DEFAULT_PLAYER_HUE);
  const currentReadingRef = useRef<AirMouseOrientation | null>(null);
  const originRef = useRef<AirMouseOrientation | null>(null);
  const smoothedAimRef = useRef({ x: 0, y: 0 });
  const lastSentAimRef = useRef({ x: Number.NaN, y: Number.NaN });
  const lastSentAtRef = useRef(0);
  const sequenceRef = useRef(0);
  const calibratedRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  const hasReadingRef = useRef(false);
  const roomClosedRef = useRef(false);
  const calibrationTimersRef = useRef<number[]>([]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => () => {
    for (const timer of calibrationTimersRef.current) window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (sensorStatus !== "idle") return;
    const timer = window.setTimeout(() => {
      if (typeof DeviceOrientationEvent === "undefined") {
        setSensorStatus("unsupported");
        return;
      }
      const orientation = DeviceOrientationEvent as PermissionCapableOrientation;
      if (typeof orientation.requestPermission !== "function") {
        setSensorStatus("active");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sensorStatus]);

  useEffect(() => {
    const id = getPlayerId(roomCode);
    playerIdRef.current = id;
    const storedName = localStorage.getItem("cursor-tag-nickname") ?? "";
    const storedHue = normalizePlayerHue(
      Number(localStorage.getItem("cursor-tag-player-hue") ?? DEFAULT_PLAYER_HUE),
    );
    const wasJoined = sessionStorage.getItem(`cursor-tag-joined-${roomCode}`) === "true";
    nicknameRef.current = storedName;
    playerHueRef.current = storedHue;
    joinedRef.current = wasJoined;
    const hydrationTimer = window.setTimeout(() => {
      setPlayerId(id);
      setNickname(storedName);
      setPlayerHue(storedHue);
      setJoined(wasJoined);
    }, 0);

    function handleMessage(message: ServerRoomMessage) {
      if (message.type === "room-closed") {
        if (roomClosedRef.current) return;
        roomClosedRef.current = true;
        joinedRef.current = false;
        sessionStorage.removeItem(`cursor-tag-joined-${roomCode}`);
        for (const timer of calibrationTimersRef.current) window.clearTimeout(timer);
        calibrationTimersRef.current = [];
        setStatus("error");
        setRoomUnavailable(true);
        socketRef.current?.close();
        return;
      }
      if (message.type === "connected") {
        setSnapshot(normalizeRoomSnapshot(message.payload.snapshot));
        if (message.payload.snapshot.phase === "playing") setNow(Date.now());
      }
      if (message.type === "snapshot" || message.type === "tag") {
        setSnapshot(normalizeRoomSnapshot(message.payload));
        if (message.payload.phase === "playing") setNow(Date.now());
      }
      if (message.type === "timeout") {
        setSnapshot(normalizeRoomSnapshot(message.payload.snapshot));
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
          socketRef.current?.send({
            type: "join",
            payload: {
              name: nicknameRef.current,
              hue: playerHueRef.current,
              calibrated: calibratedRef.current,
            },
          });
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

  const localShieldUntil = snapshot.players.find(
    (candidate) => candidate.id === playerId,
  )?.shieldUntil;
  const localMovementUntil = snapshot.players.find(
    (candidate) => candidate.id === playerId,
  )?.movementModifierUntil;

  useEffect(() => {
    if ((!snapshot.invulnerableUntil && !localShieldUntil && !localMovementUntil) || snapshot.phase !== "playing") return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [localMovementUntil, localShieldUntil, snapshot.invulnerableUntil, snapshot.phase]);

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
      if (!origin || !calibratedRef.current || snapshotRef.current.phase === "finished") return;
      const localPlayer = snapshotRef.current.players.find(
        (candidate) => candidate.id === playerIdRef.current,
      );
      const activeModifier =
        localPlayer?.movementModifierUntil && Date.now() < localPlayer.movementModifierUntil
          ? localPlayer.movementModifier
          : null;
      const movementMultiplier =
        activeModifier === "boost"
          ? POWER_UP_CONFIG.boostMultiplier
          : activeModifier === "slow"
            ? POWER_UP_CONFIG.slowMultiplier
            : 1;
      const movementSmoothing =
        activeModifier === "boost"
          ? POWER_UP_CONFIG.boostSmoothing
          : activeModifier === "slow"
            ? POWER_UP_CONFIG.slowSmoothing
            : AIR_MOUSE_CONFIG.smoothing;
      const next = calculateAirMouseAim(
        current,
        origin,
        smoothedAimRef.current,
        { sensitivity: movementMultiplier, smoothing: movementSmoothing },
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
    localStorage.setItem("cursor-tag-player-hue", String(playerHueRef.current));
    sessionStorage.setItem(`cursor-tag-joined-${roomCode}`, "true");
    socketRef.current?.send({
      type: "join",
      payload: { name: cleanName, hue: playerHueRef.current },
    });
  }

  function chooseHue(value: number) {
    const nextHue = normalizePlayerHue(value);
    playerHueRef.current = nextHue;
    setPlayerHue(nextHue);
    localStorage.setItem("cursor-tag-player-hue", String(nextHue));
  }

  async function enableMotionAgain() {
    await requestMotionAccess();
  }

  function applyNeutralPosition(showReadyStep = false) {
    const reading = currentReadingRef.current;
    if (!reading) return false;
    originRef.current = reading;
    smoothedAimRef.current = { x: 0, y: 0 };
    calibratedRef.current = true;
    if (showReadyStep) {
      setCalibrationStep("done");
      calibrationTimersRef.current.push(
        window.setTimeout(() => setCalibrated(true), 750),
      );
    } else {
      setCalibrated(true);
    }
    socketRef.current?.send({ type: "calibrated" });

    if (snapshotRef.current.phase !== "finished") {
      const sentAt = performance.now();
      lastSentAimRef.current = { x: 0, y: 0 };
      lastSentAtRef.current = sentAt;
      sequenceRef.current += 1;
      socketRef.current?.send({
        type: "cursor",
        payload: {
          x: 0.5,
          y: 0.5,
          sequence: sequenceRef.current,
          clientSentAt: sentAt,
        },
      });
    } else {
      lastSentAimRef.current = { x: Number.NaN, y: Number.NaN };
      lastSentAtRef.current = 0;
    }
    return true;
  }

  async function keepScreenAwake() {
    try {
      const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<unknown> } }).wakeLock;
      await wakeLock?.request("screen");
    } catch {
      // Screen Wake Lock is a convenience, not a gameplay requirement.
    }
  }

  function beginSteadyCalibration() {
    if (!hasReading || calibrationStep === "steady") return;
    setCalibrationStep("steady");
    setCalibrationCountdown(3);
    navigator.vibrate?.(20);

    calibrationTimersRef.current = [
      window.setTimeout(() => setCalibrationCountdown(2), 650),
      window.setTimeout(() => setCalibrationCountdown(1), 1_300),
      window.setTimeout(() => {
        if (!applyNeutralPosition(true)) {
          setCalibrationStep("aim");
          return;
        }
        navigator.vibrate?.(45);
        void keepScreenAwake();
      }, 1_950),
    ];
  }

  function recalibrateImmediately() {
    if (!applyNeutralPosition()) return;
    setNeutralReset(true);
    navigator.vibrate?.(35);
    window.setTimeout(() => setNeutralReset(false), 1_200);
  }

  const player = snapshot.players.find((candidate) => candidate.id === playerId);
  const selectedColor = playerColorFromHue(playerHue);
  const isIt = snapshot.itPlayerId === playerId;
  const isProtected = Boolean(
    (isIt &&
      snapshot.protectedPlayerId === playerId &&
      snapshot.invulnerableUntil &&
      now < snapshot.invulnerableUntil) ||
      (player?.shieldUntil && now < player.shieldUntil),
  );
  const movementModifier =
    player?.movementModifierUntil && now < player.movementModifierUntil
      ? player.movementModifier
      : null;

  if (roomUnavailable) {
    return (
      <PhoneShell roomCode={roomCode} status="error" latencyMs={null}>
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <div className="grid size-20 place-items-center rounded-[1.7rem] border border-[#ff5c5c]/20 bg-[#ff5c5c]/10 text-[#ff9292]"><CircleAlert className="size-9" /></div>
          <span className="phone-eyebrow mt-7">Room {roomCode}</span>
          <h1 className="mt-3 text-5xl font-black leading-[.92] tracking-[-.06em]">ROOM NOT<br />FOUND.</h1>
          <p className="mt-4 max-w-xs text-white/50">This room isn’t open. Check the code, or ask the host to start a new room.</p>
          <Link href="/" className="mt-8 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#b7ff45] font-black text-[#10120f] shadow-[0_6px_0_#648d20]"><ArrowRight className="size-4 rotate-180" /> Back to home</Link>
        </div>
      </PhoneShell>
    );
  }

  if (!joined) {
    return (
      <PhoneShell roomCode={roomCode} status={status} latencyMs={latencyMs} color={selectedColor}>
        <div className="flex flex-1 flex-col justify-center py-6 sm:py-8">
          <span className="phone-eyebrow">Room {roomCode}</span>
          <h1 className="mt-4 text-[2.7rem] font-black leading-[.92] tracking-[-.06em] sm:text-5xl">PICK A NAME.<br /><span style={{ color: selectedColor }}>PICK YOUR COLOR.</span></h1>
          <p className="mt-4 text-sm leading-relaxed text-white/50 sm:text-base">This color is your cursor on the big screen. Drag the hue until it feels unmistakably yours.</p>
          <SharedGameSettings snapshot={snapshot} />
          <form onSubmit={joinRoom} className="mt-6 rounded-[1.75rem] border border-white/10 bg-[#191c18] p-5 shadow-[0_20px_70px_rgba(0,0,0,.35)]">
            <label htmlFor="nickname" className="text-sm font-black">Your name</label>
            <div className="mt-2 flex h-14 items-center rounded-2xl border border-white/8 bg-white/[.055] px-4 focus-within:ring-4 focus-within:ring-[#7c5cff]/20">
              <UserRound className="size-5 text-white/35" />
              <input id="nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={18} autoComplete="nickname" placeholder="e.g. Speedy Sam" className="min-w-0 flex-1 bg-transparent px-3 font-bold text-white outline-none placeholder:text-white/25" />
            </div>
            <div className="mt-5 rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center gap-4">
                <span className="grid size-16 shrink-0 place-items-center rounded-full border-[5px] border-white shadow-[0_8px_30px_rgba(0,0,0,.35)]" style={{ backgroundColor: selectedColor }} aria-hidden="true">
                  <span className="size-2 rounded-full bg-white" />
                </span>
                <div className="min-w-0 flex-1 text-left">
                  <label htmlFor="player-hue" className="block text-xs font-black uppercase tracking-[.16em] text-white/45">Your cursor color</label>
                  <p className="mt-1 text-xl font-black" style={{ color: selectedColor }}>THIS IS YOU</p>
                  <p className="font-mono text-[11px] font-bold text-white/35">Hue {playerHue}°</p>
                </div>
              </div>
              <input
                id="player-hue"
                type="range"
                min="0"
                max="359"
                value={playerHue}
                onChange={(event) => chooseHue(Number(event.target.value))}
                aria-label={`Cursor hue ${playerHue} degrees`}
                className="hue-slider mt-4 w-full"
                style={{ accentColor: selectedColor, color: selectedColor }}
              />
            </div>
            <button type="submit" disabled={!nickname.trim() || status !== "connected" || !snapshot.hostConnected || sensorStatus === "requesting"} className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#b7ff45] font-black text-[#10120f] shadow-[0_6px_0_#648d20] active:translate-y-1 active:shadow-[0_2px_0_#648d20] disabled:bg-white/8 disabled:text-white/25 disabled:shadow-none">
              {sensorStatus === "requesting" ? <LoaderCircle className="size-5 animate-spin" /> : <Move3d className="size-5" />}
              {sensorStatus === "requesting" ? "Requesting motion…" : !snapshot.hostConnected ? "Waiting for host" : "Enable motion & join"}
              {sensorStatus !== "requesting" && <ArrowRight className="size-4" />}
            </button>
            {(sensorStatus === "denied" || sensorStatus === "unsupported") && <MotionError status={sensorStatus} />}
            {error && <p className="mt-3 rounded-xl border border-[#ff5c5c]/20 bg-[#ff5c5c]/10 px-3 py-2 text-xs font-bold text-[#ff9292]">{error}</p>}
          </form>
        </div>
      </PhoneShell>
    );
  }

  if (sensorStatus !== "active" || !calibrated) {
    return (
      <PhoneShell roomCode={roomCode} status={status} latencyMs={latencyMs} color={player?.color}>
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <div className="mb-7 grid w-full max-w-sm grid-cols-3 gap-2" aria-label="Calibration progress">
            <CalibrationStepPill number="1" label="Aim" state={calibrationStep === "aim" ? "active" : "complete"} />
            <CalibrationStepPill number="2" label="Hold" state={calibrationStep === "steady" ? "active" : calibrationStep === "done" ? "complete" : "upcoming"} />
            <CalibrationStepPill number="3" label="Ready" state={calibrationStep === "done" ? "active" : "upcoming"} />
          </div>

          {calibrationStep === "aim" ? <>
            <div className="relative grid h-28 w-44 place-items-center rounded-[2rem] border border-white/10 bg-[#191c18] shadow-[0_18px_55px_rgba(0,0,0,.3)]">
              <div className="calibration-preview-target grid size-12 place-items-center rounded-full border border-[#b7ff45]/70">
                <span className="size-2.5 rounded-full bg-[#b7ff45] shadow-[0_0_14px_#b7ff45]" />
              </div>
              <Smartphone className="calibration-phone absolute -bottom-4 -right-1 size-12 rotate-[-12deg] text-white" />
            </div>
            <span className="phone-eyebrow mt-8">Step 1 of 3</span>
            <h1 className="mt-3 text-4xl font-black leading-[.96] tracking-[-.055em]">AIM AT<br />THE DOT.</h1>
            <p className="mt-4 max-w-xs font-semibold leading-relaxed text-white/55">Find the small lime dot in the middle of the big screen. Hold your phone like a remote and point its top edge at it.</p>
            {sensorStatus !== "active" ? (
              <button type="button" onClick={() => void enableMotionAgain()} className="mt-8 flex h-15 w-full items-center justify-center gap-2 rounded-2xl bg-[#7c5cff] font-black text-white shadow-[0_7px_0_#4935a5]"><Move3d className="size-5" /> Enable motion</button>
            ) : (
              <button type="button" onClick={beginSteadyCalibration} disabled={!hasReading} className="mt-8 flex h-15 w-full items-center justify-center gap-2 rounded-2xl bg-[#b7ff45] font-black text-[#10120f] shadow-[0_7px_0_#789f35] active:translate-y-1 active:shadow-[0_2px_0_#789f35] disabled:opacity-40 disabled:shadow-none">
                {hasReading ? <CircleDot className="size-5" /> : <LoaderCircle className="size-5 animate-spin" />}
                {hasReading ? "I’m aiming at the dot" : "Reading sensors…"}
              </button>
            )}
          </> : calibrationStep === "steady" ? <>
            <div className="grid size-28 place-items-center rounded-full border border-[#b7ff45]/35 bg-[#b7ff45]/10 shadow-[0_0_45px_rgba(183,255,69,.16)]" aria-live="polite">
              <span className="font-mono text-6xl font-black tabular-nums text-[#b7ff45]">{calibrationCountdown}</span>
            </div>
            <span className="phone-eyebrow mt-8">Step 2 of 3</span>
            <h1 className="mt-3 text-4xl font-black leading-[.96] tracking-[-.055em]">HOLD<br />STEADY.</h1>
            <p className="mt-4 max-w-xs font-semibold leading-relaxed text-white/55">Keep pointing at the dot. Your center position locks automatically when the countdown ends.</p>
            <div className="mt-7 flex items-center gap-2 rounded-full border border-[#b7ff45]/20 bg-[#b7ff45]/8 px-4 py-2.5 text-sm font-black text-[#b7ff45]"><LoaderCircle className="size-4 animate-spin" /> Locking your center…</div>
          </> : <>
            <div className="grid size-28 place-items-center rounded-full bg-[#b7ff45] text-[#10120f] shadow-[0_0_45px_rgba(183,255,69,.28)]"><Check className="size-14" strokeWidth={3} /></div>
            <span className="phone-eyebrow mt-8">Step 3 of 3</span>
            <h1 className="mt-3 text-4xl font-black leading-[.96] tracking-[-.055em]">CENTER<br />LOCKED.</h1>
            <p className="mt-4 max-w-xs font-semibold leading-relaxed text-white/55">Done. Your cursor will start in the middle of the big screen.</p>
          </>}
          {(sensorStatus === "denied" || sensorStatus === "unsupported") && <MotionError status={sensorStatus} />}
        </div>
      </PhoneShell>
    );
  }

  if (snapshot.phase === "finished") {
    return (
      <PhoneShell roomCode={roomCode} status={status} latencyMs={latencyMs} color={player?.color}>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <Trophy className="size-16 text-[#9b87ff]" />
          <span className="phone-eyebrow mt-6">Game over</span>
          <h1 className="mt-3 text-5xl font-black tracking-[-.06em]">{player?.score ?? 0} POINTS</h1>
          <p className="mt-3 text-white/50">Check the big screen for the final ranking.</p>
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
          <p className="mt-4 max-w-xs text-white/50">Move your phone now—your cursor is already live in the warm-up arena on the big screen.</p>
          <SharedGameSettings snapshot={snapshot} />
          <div className="mt-7 flex items-center gap-2 rounded-full border border-white/10 bg-white/[.055] px-4 py-2.5 text-sm font-black shadow-sm"><Move3d className="size-4 text-[#9b87ff]" /> Warm up while others join</div>
        </div>
      </PhoneShell>
    );
  }

  return (
    <PhoneShell roomCode={roomCode} status={status} latencyMs={latencyMs} color={player?.color}>
      <div className="flex flex-1 flex-col py-6">
        <div className={`relative flex flex-1 flex-col items-center justify-center overflow-hidden rounded-[2.25rem] border text-center shadow-xl ${isIt ? "border-[#ff5c5c]/30 bg-[#ff5c5c] text-white" : "border-white/10 bg-[#191c18] text-white"}`}>
          <div className="controller-rings absolute inset-0 opacity-25" />
          <div className="relative grid size-28 place-items-center rounded-full border-[8px] border-white shadow-[0_16px_45px_rgba(0,0,0,.3)]" style={{ backgroundColor: player?.color ?? "#b7ff45" }} role="img" aria-label={isIt ? "You are it" : "Your cursor"}>
            {isIt ? <Star className="size-14 fill-white text-white" strokeWidth={2.4} /> : <span className="size-3 rounded-full bg-white" />}
            {isProtected && <span className="absolute -right-2 -top-2 grid size-9 place-items-center rounded-full bg-[#b7ff45] text-[#10120f] shadow-lg"><ShieldCheck className="size-5" /></span>}
          </div>
          <p className="relative mt-8 font-mono text-sm font-black uppercase tracking-[.14em] text-white/65">{player?.score ?? 0} points</p>
          <p className="relative mt-3 text-xs font-black uppercase tracking-[.22em] text-white/55">Round {snapshot.round} / {snapshot.maxRounds}</p>
          <h1 className="relative mt-2 text-5xl font-black leading-[.9] tracking-[-.06em]">{isProtected ? "GET READY" : isIt ? "YOU’RE IT!" : "KEEP MOVING"}</h1>
          <p className="relative mt-4 max-w-[270px] text-sm font-semibold leading-relaxed text-white/70">{isProtected ? "Your shield prevents an instant re-tag. Move clear!" : isIt ? "Pass it to someone for +1." : "Survive until time runs out for +1."}</p>
          {isProtected && <span className="relative mt-5 inline-flex items-center gap-2 rounded-full bg-white/18 px-4 py-2 text-xs font-black uppercase tracking-[.12em]"><ShieldCheck className="size-4" /> Tag shield</span>}
          {movementModifier && <span className={`relative mt-3 inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-black uppercase tracking-[.12em] ${movementModifier === "boost" ? "bg-[#b7ff45] text-[#10120f]" : "bg-[#ff9f43] text-[#241302]"}`}>{movementModifier === "boost" ? <Zap className="size-5 fill-current" /> : <Snail className="size-5" />} {movementModifier === "boost" ? `Turbo ×${POWER_UP_CONFIG.boostMultiplier}` : `Slowed ×${POWER_UP_CONFIG.slowMultiplier}`}</span>}
        </div>
        <button type="button" onClick={recalibrateImmediately} disabled={!hasReading} className={`mt-4 flex h-13 items-center justify-center gap-2 rounded-2xl border text-sm font-black active:scale-[.98] disabled:opacity-35 ${neutralReset ? "border-[#b7ff45]/30 bg-[#b7ff45]/12 text-[#b7ff45]" : "border-white/10 bg-white/[.055] text-white/55"}`}><RotateCcw className={`size-4 ${neutralReset ? "rotate-180 transition-transform" : ""}`} /> {neutralReset ? "Neutral reset" : "Recalibrate instantly"}</button>
      </div>
    </PhoneShell>
  );
}

function SharedGameSettings({ snapshot }: { snapshot: RoomSnapshot }) {
  return (
    <div className="mt-5 w-full max-w-sm rounded-2xl border border-white/10 bg-white/[.045] p-3 text-left" aria-label="Game settings">
      <p className="text-[10px] font-black uppercase tracking-[.14em] text-[#b7ff45]">Game settings</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <SettingValue label="Rounds" value={String(snapshot.maxRounds)} />
        <SettingValue label="Round time" value={`${snapshot.roundSeconds}s`} />
        <SettingValue label="Power-ups" value={snapshot.powerUpMode} />
      </div>
    </div>
  );
}

function SettingValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-black/20 px-2.5 py-2">
      <p className="text-[9px] font-black uppercase tracking-[.08em] text-white/30">{label}</p>
      <p className="mt-0.5 truncate text-xs font-black capitalize text-white/75">{value}</p>
    </div>
  );
}

function CalibrationStepPill({ number, label, state }: { number: string; label: string; state: "active" | "complete" | "upcoming" }) {
  return (
    <div className={`flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-[11px] font-black uppercase tracking-[.08em] ${state === "active" ? "border-[#b7ff45]/35 bg-[#b7ff45]/12 text-[#b7ff45]" : state === "complete" ? "border-white/10 bg-white/[.055] text-white/65" : "border-white/8 bg-transparent text-white/25"}`}>
      {state === "complete" ? <Check className="size-3.5" /> : <span className="font-mono">{number}</span>}{label}
    </div>
  );
}

function PhoneShell({ roomCode, status, latencyMs, color, children }: { roomCode: string; status: RoomConnectionStatus; latencyMs: number | null; color?: string; children: React.ReactNode }) {
  return (
    <main className="phone-shell min-h-dvh overflow-x-hidden bg-[#10120f] px-4 text-[#f5f5ec]">
      <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col">
        <header className="flex h-17 items-center justify-between border-b border-white/[.08]">
          <CursorTagLogo />
          <div className="flex items-center gap-2">
            {latencyMs !== null && <span className={`rounded-full border px-2.5 py-1.5 font-mono text-[10px] font-black ${latencyMs <= 80 ? "border-[#b7ff45]/20 bg-[#b7ff45]/10 text-[#b7ff45]" : latencyMs <= 140 ? "border-amber-400/20 bg-amber-400/10 text-amber-300" : "border-[#ff5c5c]/20 bg-[#ff5c5c]/10 text-[#ff9292]"}`}>{latencyMs}ms</span>}
            <span className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[.055] px-2.5 py-1.5 font-mono text-[10px] font-black tracking-[.1em] text-white/75 shadow-sm">{status === "connected" ? <Wifi className="size-3" style={{ color: color ?? "#9b87ff" }} /> : <WifiOff className="size-3 text-[#ff5c5c]" />}{roomCode}</span>
          </div>
        </header>
        {children}
      </div>
    </main>
  );
}

function MotionError({ status }: { status: SensorStatus }) {
  return <div className="mt-4 flex items-start gap-2 rounded-xl border border-[#ff5c5c]/20 bg-[#ff5c5c]/10 p-3 text-left text-xs font-bold leading-relaxed text-[#ff9292]"><CircleAlert className="mt-0.5 size-4 shrink-0" />{status === "unsupported" ? "This browser does not expose motion sensors. Open the link in Safari on iPhone or Chrome on Android." : "Motion access was denied. Allow Motion & Orientation in your browser settings, then try again."}</div>;
}
