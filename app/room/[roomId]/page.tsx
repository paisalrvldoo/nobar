"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type ChatMessage = {
  id: string;
  text: string;
  sender: string;
};

type VideoControl = {
  action: "play" | "pause" | "seek";
  time: number;
};

const VIDEO_SERVER = "https://annie-efforts-columns-federal.trycloudflare.com";

export default function RoomPage() {
  const params = useParams();
  const roomId = String(params.roomId || "").toUpperCase();

  const videoRef = useRef<HTMLVideoElement>(null);
  const channelRef = useRef<any>(null);

  // Mencegah event dari partner dikirim balik lagi
  const remoteUpdateRef = useRef(false);

  const [userId, setUserId] = useState("");
  const [hostId, setHostId] = useState("");
  const [movieUrl, setMovieUrl] = useState<string | null>(null);

  const [onlineCount, setOnlineCount] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const isHost = userId !== "" && userId === hostId;

  // =========================
  // USER ID
  // =========================

  useEffect(() => {
    let id = sessionStorage.getItem("nobar_user_id");

    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("nobar_user_id", id);
    }

    setUserId(id);
  }, []);

  // =========================
  // LOAD ROOM
  // =========================

  useEffect(() => {
    if (!roomId || !userId) return;

    const loadRoom = async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("host_id, movie_url")
        .eq("code", roomId)
        .maybeSingle();

      if (error) {
        console.error(error);
        return;
      }

      if (!data) {
        alert("Room tidak ditemukan");
        return;
      }

      setHostId(data.host_id || "");
      setMovieUrl(data.movie_url || null);
    };

    loadRoom();
  }, [roomId, userId]);

  // =========================
  // REALTIME ROOM
  // =========================

  useEffect(() => {
    if (!roomId || !userId) return;

    const channel = supabase.channel(`room:${roomId}`, {
      config: {
        presence: {
          key: userId,
        },
      },
    });

    channelRef.current = channel;

    const updatePresence = () => {
      const state = channel.presenceState();
      const users = Object.values(state).flat();

      setOnlineCount(users.length);
    };

    channel
      .on("presence", { event: "sync" }, updatePresence)

      .on("presence", { event: "join" }, updatePresence)

      .on("presence", { event: "leave" }, updatePresence)

      // =========================
      // MOVIE UPDATE
      // =========================

      .on(
        "broadcast",
        { event: "movie_updated" },
        ({ payload }) => {
          if (payload?.movieUrl) {
            setMovieUrl(payload.movieUrl);
          }
        }
      )

      // =========================
      // VIDEO SYNC
      // =========================

      .on(
        "broadcast",
        { event: "video_control" },
        async ({ payload }: { payload: VideoControl }) => {
          const video = videoRef.current;

          if (!video || !payload) return;

          remoteUpdateRef.current = true;

          try {
            if (payload.action === "seek") {
              video.currentTime = payload.time;
            }

            if (payload.action === "play") {
              video.currentTime = payload.time;

              await video.play().catch(() => {});
            }

            if (payload.action === "pause") {
              video.currentTime = payload.time;
              video.pause();
            }
          } finally {
            setTimeout(() => {
              remoteUpdateRef.current = false;
            }, 100);
          }
        }
      )

      // =========================
      // CHAT
      // =========================

      .on("broadcast", { event: "chat" }, ({ payload }) => {
        if (!payload) return;

        setMessages((current) => {
          if (current.some((item) => item.id === payload.id)) {
            return current;
          }

          return [...current, payload];
        });
      })

      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({
            user_id: userId,
            online_at: new Date().toISOString(),
          });

          updatePresence();
        }
      });

    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
    };
  }, [roomId, userId]);

  // =========================
  // UPLOAD MOVIE
  // =========================

  const uploadMovie = async (file: File) => {
    if (!isHost) {
      alert("Hanya pembuat room yang bisa upload movie");
      return;
    }

    const MAX_SIZE = 2 * 1024 * 1024 * 1024;

    if (file.size > MAX_SIZE) {
      alert("Ukuran movie maksimal 2 GB");
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      const formData = new FormData();

      formData.append("movie", file);

      const xhr = new XMLHttpRequest();

      const uploadPromise = new Promise<any>((resolve, reject) => {
        xhr.open("POST", `${VIDEO_SERVER}/upload`);

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round(
              (event.loaded / event.total) * 100
            );

            setUploadProgress(percent);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch {
              reject(new Error("Response server tidak valid"));
            }
          } else {
            reject(
              new Error(`Upload gagal. Server HTTP ${xhr.status}`)
            );
          }
        };

        xhr.onerror = () => {
          reject(new Error("Koneksi ke VPS gagal"));
        };

        xhr.onabort = () => {
          reject(new Error("Upload dibatalkan"));
        };

        xhr.send(formData);
      });

      const result = await uploadPromise;

      if (!result?.success || !result?.url) {
        throw new Error("Server VPS tidak memberikan URL movie");
      }

      const publicUrl = `${VIDEO_SERVER}${result.url}`;

      const { error: updateError } = await supabase
        .from("rooms")
        .update({
          movie_url: publicUrl,
        })
        .eq("code", roomId)
        .eq("host_id", userId);

      if (updateError) {
        console.error(updateError);

        alert(
          `Movie sudah terupload ke VPS, tapi gagal menyimpan room: ${updateError.message}`
        );

        return;
      }

      setMovieUrl(publicUrl);

      await channelRef.current?.send({
        type: "broadcast",
        event: "movie_updated",
        payload: {
          movieUrl: publicUrl,
        },
      });

      alert("Movie berhasil diupload 🎬");
    } catch (error: any) {
      console.error(error);

      alert(
        `Upload gagal: ${
          error?.message || "Terjadi kesalahan"
        }`
      );
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  // =========================
  // SEND VIDEO CONTROL
  // =========================

  const sendVideoControl = async (
    action: VideoControl["action"],
    time: number
  ) => {
    if (!isHost || !channelRef.current) return;

    await channelRef.current.send({
      type: "broadcast",
      event: "video_control",
      payload: {
        action,
        time,
      },
    });
  };

  // =========================
  // PLAY / PAUSE
  // =========================

  const togglePlay = async () => {
    const video = videoRef.current;

    if (!video || !movieUrl) return;

    if (!isHost) return;

    if (video.paused) {
      await video.play();

      await sendVideoControl(
        "play",
        video.currentTime
      );
    } else {
      video.pause();

      await sendVideoControl(
        "pause",
        video.currentTime
      );
    }
  };

  // =========================
  // HOST SEEK
  // =========================

  const handleSeek = async () => {
    const video = videoRef.current;

    if (!video || !isHost) return;

    if (remoteUpdateRef.current) return;

    await sendVideoControl(
      "seek",
      video.currentTime
    );
  };

  // =========================
  // MUTE
  // =========================

  const toggleMute = () => {
    const video = videoRef.current;

    if (!video) return;

    video.muted = !video.muted;

    setMuted(video.muted);
  };

  // =========================
  // CHAT
  // =========================

  const sendMessage = async () => {
    const text = message.trim();

    if (!text || !channelRef.current) return;

    const newMessage: ChatMessage = {
      id: `${userId}-${Date.now()}`,
      text,
      sender: userId,
    };

    setMessages((current) => [
      ...current,
      newMessage,
    ]);

    setMessage("");

    await channelRef.current.send({
      type: "broadcast",
      event: "chat",
      payload: newMessage,
    });
  };

  // =========================
  // UI
  // =========================

  return (
    <main className="min-h-screen bg-[#070707] text-white">

      {/* HEADER */}

      <header className="flex h-16 items-center justify-between border-b border-white/10 px-5">

        <div className="flex items-center gap-3">

          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-black">
            🍿
          </div>

          <span className="font-semibold tracking-tight">
            NOBAR
          </span>

        </div>

        <div className="flex items-center gap-3">

          <div className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs text-white/50">
            Room:
            <span className="ml-1 font-mono text-white/80">
              {roomId}
            </span>
          </div>

          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs">
            <span className="h-2 w-2 rounded-full bg-green-400" />
            {Math.min(onlineCount, 2)} / 2
          </div>

        </div>

      </header>

      {/* CONTENT */}

      <div className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[1fr_340px]">

        {/* VIDEO */}

        <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#111]">

          <div className="relative aspect-video bg-black">

            {movieUrl ? (

              <video
                ref={videoRef}
                src={movieUrl}
                className="h-full w-full object-contain"
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onSeeked={handleSeek}
                controls={false}
                playsInline
              />

            ) : (

              <div className="absolute inset-0 flex flex-col items-center justify-center">

                <div className="mb-5 text-6xl">
                  🍿
                </div>

                <h2 className="text-xl font-semibold">
                  No movie yet
                </h2>

                <p className="mt-2 text-sm text-white/30">
                  {isHost
                    ? "Upload a movie to start watching"
                    : "Waiting for the host to upload a movie..."}
                </p>

              </div>

            )}

            {/* HOST UPLOAD */}

            {isHost && (

              <div className="absolute bottom-5 left-5">

                <label
                  className={`cursor-pointer rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-white/90 ${
                    uploading
                      ? "pointer-events-none opacity-70"
                      : ""
                  }`}
                >

                  {uploading
                    ? `Uploading ${uploadProgress}%`
                    : "🎬 Upload Movie"}

                  <input
                    type="file"
                    accept="video/*"
                    disabled={uploading}
                    className="hidden"
                    onChange={(e) => {

                      const file =
                        e.target.files?.[0];

                      if (file) {
                        uploadMovie(file);
                      }

                      e.currentTarget.value = "";

                    }}
                  />

                </label>

                {uploading && (

                  <div className="mt-3 h-1.5 w-56 overflow-hidden rounded-full bg-white/20">

                    <div
                      className="h-full bg-white transition-all"
                      style={{
                        width: `${uploadProgress}%`,
                      }}
                    />

                  </div>

                )}

              </div>

            )}

          </div>

          {/* CONTROLS */}

          <div className="border-t border-white/10 p-4">

            <div className="flex items-center justify-between">

              <div className="flex items-center gap-4">

                <button
                  onClick={togglePlay}
                  disabled={!movieUrl || !isHost}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {isPlaying ? "Ⅱ" : "▶"}
                </button>

                <button
                  onClick={toggleMute}
                  disabled={!movieUrl}
                  className="text-lg disabled:opacity-30"
                >
                  {muted ? "🔇" : "🔊"}
                </button>

              </div>

              <div className="text-xs text-white/30">

                {isHost
                  ? "You are the host"
                  : "Watching with host"}

              </div>

            </div>

          </div>

        </section>

        {/* SIDEBAR */}

        <aside className="flex min-h-[550px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111]">

          {/* PEOPLE */}

          <div className="border-b border-white/10 p-5">

            <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-white/30">
              Watching Together
            </p>

            <div className="flex items-center gap-3">

              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-pink-400 to-purple-500 font-semibold">
                {isHost ? "H" : "Y"}
              </div>

              <div>

                <p className="text-sm font-medium">
                  {isHost ? "You · Host" : "You"}
                </p>

                <p className="text-xs text-green-400">
                  ● Online
                </p>

              </div>

            </div>

            {onlineCount >= 2 ? (

              <div className="mt-4 flex items-center gap-3">

                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-blue-400 to-cyan-500 font-semibold">
                  P
                </div>

                <div>

                  <p className="text-sm font-medium">
                    Partner
                  </p>

                  <p className="text-xs text-green-400">
                    ● Online
                  </p>

                </div>

              </div>

            ) : (

              <div className="mt-4 flex items-center gap-3">

                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/30">
                  ?
                </div>

                <div>

                  <p className="text-sm text-white/40">
                    Waiting for partner
                  </p>

                  <p className="text-xs text-white/20">
                    Share your room link
                  </p>

                </div>

              </div>

            )}

          </div>

          {/* CALL */}

          <div className="border-b border-white/10 p-5">

            <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-white/30">
              Voice Call
            </p>

            <div className="flex gap-2">

              <button className="flex-1 rounded-xl border border-white/10 bg-white/[0.04] py-3 text-sm transition hover:bg-white/10">
                🎙️ Mute
              </button>

              <button className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-white/90">
                📞 Call
              </button>

            </div>

          </div>

          {/* CHAT */}

          <div className="flex min-h-0 flex-1 flex-col">

            <div className="border-b border-white/10 p-5">

              <p className="text-xs font-semibold uppercase tracking-wider text-white/30">
                Chat
              </p>

            </div>

            <div className="flex-1 space-y-2 overflow-y-auto p-4">

              {messages.length === 0 ? (

                <div className="rounded-xl bg-white/[0.04] p-3 text-sm text-white/40">
                  💕 Say something to your partner...
                </div>

              ) : (

                messages.map((item) => (

                  <div
                    key={item.id}
                    className={`max-w-[85%] rounded-xl p-3 text-sm ${
                      item.sender === userId
                        ? "ml-auto bg-white text-black"
                        : "bg-white/[0.06] text-white"
                    }`}
                  >
                    {item.text}
                  </div>

                ))

              )}

            </div>

            <div className="border-t border-white/10 p-3">

              <div className="flex gap-2">

                <input
                  value={message}
                  onChange={(e) =>
                    setMessage(e.target.value)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      sendMessage();
                    }
                  }}
                  placeholder="Type a message..."
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-sm outline-none placeholder:text-white/20 focus:border-white/20"
                />

                <button
                  onClick={sendMessage}
                  className="rounded-xl bg-white px-4 font-medium text-black"
                >
                  ↑
                </button>

              </div>

            </div>

          </div>

        </aside>

      </div>

    </main>
  );
}