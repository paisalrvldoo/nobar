"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

function getUserId() {
  const existing = sessionStorage.getItem("nobar_user_id");

  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();
  sessionStorage.setItem("nobar_user_id", id);

  return id;
}

export default function Home() {
  const [roomCode, setRoomCode] = useState("");
  const [loading, setLoading] = useState(false);

  const createRoom = async () => {
    setLoading(true);

    const code = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();

    const userId = getUserId();

    const { error } = await supabase
      .from("rooms")
      .insert({
        code,
        host_id: userId,
      });

    if (error) {
      console.error(error);
      alert("Gagal membuat room");
      setLoading(false);
      return;
    }

    window.location.href = `/room/${code}`;
  };

  const joinRoom = async () => {
    const code = roomCode.trim().toUpperCase();

    if (!code) return;

    setLoading(true);

    const { data, error } = await supabase
      .from("rooms")
      .select("code")
      .eq("code", code)
      .maybeSingle();

    if (error) {
      console.error(error);
      alert("Gagal mengecek room");
      setLoading(false);
      return;
    }

    if (!data) {
      alert("Room tidak ditemukan");
      setLoading(false);
      return;
    }

    window.location.href = `/room/${code}`;
  };

  return (
    <main className="min-h-screen bg-[#070707] text-white">
      <header className="flex h-16 items-center justify-between border-b border-white/10 px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-lg">
            🍿
          </div>

          <span className="font-semibold tracking-tight">
            NOBAR
          </span>
        </div>

        <div className="text-xs text-white/30">
          Private watch party
        </div>
      </header>

      <section className="mx-auto flex min-h-[calc(100vh-64px)] max-w-5xl flex-col items-center justify-center px-6 py-20 text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04] text-5xl shadow-2xl">
          🍿
        </div>

        <p className="mb-4 text-sm font-medium uppercase tracking-[0.3em] text-white/30">
          Private watch party for two
        </p>

        <h1 className="max-w-3xl text-5xl font-semibold tracking-tight sm:text-7xl">
          Watch movies.
          <br />
          <span className="text-white/40">Together.</span>
        </h1>

        <p className="mt-6 max-w-lg text-base leading-7 text-white/40">
          Create a private room, invite your favorite person,
          and watch movies together in sync.
        </p>

        <div className="mt-10 flex w-full max-w-md flex-col gap-3">
          <button
            onClick={createRoom}
            disabled={loading}
            className="rounded-2xl bg-white px-6 py-4 text-sm font-semibold text-black transition hover:bg-white/90 disabled:opacity-50"
          >
            {loading ? "Creating..." : "🎬 Create a Room"}
          </button>

          <div className="flex gap-2">
            <input
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  joinRoom();
                }
              }}
              placeholder="Enter room code"
              disabled={loading}
              className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4 text-sm uppercase tracking-wider outline-none placeholder:text-white/20 focus:border-white/20"
            />

            <button
              onClick={joinRoom}
              disabled={loading}
              className="rounded-2xl border border-white/10 bg-white/[0.04] px-6 text-sm font-medium transition hover:bg-white/10 disabled:opacity-50"
            >
              Join
            </button>
          </div>
        </div>

        <div className="mt-16 grid w-full max-w-2xl grid-cols-3 gap-3">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="text-xl">🔄</div>
            <p className="mt-3 text-sm font-medium">Synced</p>
            <p className="mt-1 text-xs text-white/30">
              Watch together
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="text-xl">🎙️</div>
            <p className="mt-3 text-sm font-medium">Voice</p>
            <p className="mt-1 text-xs text-white/30">
              Talk while watching
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="text-xl">🔒</div>
            <p className="mt-3 text-sm font-medium">Private</p>
            <p className="mt-1 text-xs text-white/30">
              Just the two of you
            </p>
          </div>
        </div>

        <p className="mt-10 text-xs text-white/20">
          No account required · Just create a room
        </p>
      </section>
    </main>
  );
}