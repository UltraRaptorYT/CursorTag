"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { ArrowRight, Gamepad2, MonitorUp, Radio, Zap } from "lucide-react";

import { CursorTagLogo } from "@/components/cursor-tag-logo";
import { sanitizeRoomCode } from "@/lib/game/config";

export default function HomePage() {
  const router = useRouter();
  const [roomCode, setRoomCode] = useState("");

  function joinRoom(event: FormEvent) {
    event.preventDefault();
    const code = sanitizeRoomCode(roomCode);
    if (code.length >= 4) router.push(`/room/${code}`);
  }

  return (
    <main className="landing-shell min-h-dvh overflow-hidden bg-[#10120f] text-[#f4f4e9]">
      <div className="landing-grid absolute inset-0 opacity-35" />
      <div className="relative mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col px-5 sm:px-10 lg:px-16">
        <header className="flex items-center justify-between py-6 sm:py-8">
          <CursorTagLogo />
          <span className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[.04] px-3 py-2 text-xs font-bold text-white/55 sm:flex">
            <Radio className="size-3.5 text-[#b7ff45]" /> Phones become cursors
          </span>
        </header>

        <section className="grid flex-1 items-center gap-12 py-10 lg:grid-cols-[1.05fr_.95fr] lg:py-4">
          <div className="max-w-3xl">
            <div className="mb-7 inline-flex -rotate-2 items-center gap-2 rounded-full bg-[#7c5cff] px-4 py-2 text-xs font-black uppercase tracking-[.16em] text-white shadow-[4px_4px_0_#050605]">
              <Zap className="size-3.5 fill-current" /> Live multiplayer chase
            </div>
            <h1 className="text-balance text-[clamp(4.2rem,10vw,8.8rem)] font-black leading-[.79] tracking-[-.08em]">
              TILT.<br />CHASE.<br /><span className="text-[#b7ff45]">TAG.</span>
            </h1>
            <p className="mt-8 max-w-xl text-lg font-medium leading-relaxed text-white/55 sm:text-xl">
              Turn every phone in the room into a live cursor. One player is it. Catch someone before the clock catches you.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link href="/host" className="group inline-flex h-15 items-center justify-center gap-3 rounded-2xl bg-[#b7ff45] px-7 text-base font-black text-[#10120f] shadow-[0_8px_0_#648d20] transition hover:-translate-y-0.5 hover:shadow-[0_10px_0_#648d20] active:translate-y-1 active:shadow-[0_3px_0_#648d20]">
                <MonitorUp className="size-5" /> Host a game
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
              </Link>
              <form onSubmit={joinRoom} className="flex h-15 overflow-hidden rounded-2xl border border-white/14 bg-white/[.06] focus-within:border-[#7c5cff] focus-within:ring-4 focus-within:ring-[#7c5cff]/15">
                <input value={roomCode} onChange={(event) => setRoomCode(sanitizeRoomCode(event.target.value))} placeholder="ROOM CODE" aria-label="Room code" autoCapitalize="characters" maxLength={6} className="min-w-0 flex-1 bg-transparent px-5 font-mono text-base font-black uppercase tracking-[.18em] outline-none placeholder:text-white/25" />
                <button type="submit" aria-label="Join room" disabled={roomCode.length < 4} className="grid w-15 place-items-center bg-white/10 text-white transition hover:bg-[#7c5cff] disabled:opacity-25">
                  <ArrowRight className="size-5" />
                </button>
              </form>
            </div>
          </div>

          <div className="relative mx-auto aspect-[4/5] w-full max-w-[520px] lg:max-w-none">
            <div className="absolute inset-[6%] rotate-3 rounded-[3rem] bg-[#7c5cff] shadow-[22px_28px_0_rgba(0,0,0,.24)]" />
            <div className="absolute inset-[3%_8%_9%_2%] -rotate-2 overflow-hidden rounded-[2.75rem] border border-white/10 bg-[#191c18] p-5 shadow-2xl sm:p-7">
              <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-[.2em] text-white/40">
                <span>Round 04</span><span className="text-[#ff7b7b]">● Rowan is it</span>
              </div>
              <div className="mt-10 text-center font-mono text-[clamp(4.8rem,12vw,8.5rem)] font-black leading-none tracking-[-.08em] text-white">
                08<span className="text-[#b7ff45]">.4</span>
              </div>
              <div className="relative mt-7 h-[56%] overflow-hidden rounded-[2rem] border border-white/8 bg-[#111310]">
                <div className="arena-grid absolute inset-0 opacity-45" />
                <DemoCursor className="left-[18%] top-[24%]" color="#2dd4a8" name="Maya" />
                <DemoCursor className="left-[66%] top-[63%]" color="#44a7ff" name="Ari" />
                <DemoCursor className="it-demo left-[43%] top-[45%]" color="#ff5c5c" name="Rowan · IT" />
                <div className="absolute bottom-5 left-5 right-5 flex items-center gap-3 rounded-xl border border-white/8 bg-black/30 px-4 py-3 text-xs font-bold text-white/45 backdrop-blur">
                  <Gamepad2 className="size-4 text-[#b7ff45]" /> Gyro input · real-time WebSockets · no app install
                </div>
              </div>
            </div>
          </div>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 py-5 text-xs font-semibold text-white/30">
          <span>Built for the big screen.</span><span>2–8 players · disposable rooms · zero sign-up</span>
        </footer>
      </div>
    </main>
  );
}

function DemoCursor({ color, name, className }: { color: string; name: string; className: string }) {
  return (
    <div className={`demo-cursor absolute ${className}`}>
      <span className="block size-9 rounded-full border-[4px] border-white shadow-xl" style={{ backgroundColor: color }} />
      <span className="absolute left-1/2 top-[-28px] -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-[9px] font-black text-[#10120f]" style={{ backgroundColor: color }}>{name}</span>
    </div>
  );
}

