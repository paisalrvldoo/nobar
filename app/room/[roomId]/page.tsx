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

const VIDEO_SERVER = "https://discharge-nations-dose-highway.trycloudflare.com";

export default function RoomPage() {
  const params = useParams();
  const roomId = String(params.roomId || "").toUpperCase();

  const videoRef = useRef<HTMLVideoElement>(null);
  const channelRef = useRef<any>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const remoteGainRef = useRef<GainNode | null>(null);
  const remoteSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const remoteUserRef = useRef<string | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  // Mencegah event dari partner dikirim balik lagi
  const remoteUpdateRef = useRef(false);

  const [userId, setUserId] = useState("");
  const [hostId, setHostId] = useState("");
  const [movieUrl, setMovieUrl] = useState<string | null>(null);

  const [onlineCount, setOnlineCount] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [movieVolume, setMovieVolume] = useState(1);
  const [callVolume, setCallVolume] = useState(1);
  const [callMuted, setCallMuted] = useState(false);
  const [callStatus, setCallStatus] = useState<"idle" | "calling" | "incoming" | "connected">("idle");
  const [isFullscreen, setIsFullscreen] = useState(false);

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
  // WEBRTC VOICE CALL
  // =========================

  const sendCallSignal = async (event: string, payload: any) => {
    if (!channelRef.current) return;
    await channelRef.current.send({
      type: "broadcast",
      event,
      payload: { ...payload, from: userId },
    });
  };

  const cleanupCall = () => {
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    pendingIceRef.current = [];
    remoteUserRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    remoteSourceRef.current?.disconnect();
    remoteSourceRef.current = null;
    remoteGainRef.current?.disconnect();
    remoteGainRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setCallStatus("idle");
  };

  const endVoiceCall = async (notify = true) => {
    const target = remoteUserRef.current;
    if (notify && target) {
      await sendCallSignal("call_end", { target });
    }
    cleanupCall();
  };

  const createPeer = async (target: string) => {
    if (peerRef.current) return peerRef.current;

    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    peerRef.current = peer;
    remoteUserRef.current = target;

    peer.onicecandidate = (e) => {
      if (e.candidate) {
        sendCallSignal("webrtc_ice", {
          target,
          candidate: e.candidate.toJSON(),
        });
      }
    };

    peer.ontrack = (e) => {
      const stream = e.streams[0];
      if (remoteAudioRef.current && stream) {
        remoteAudioRef.current.srcObject = stream;
        remoteAudioRef.current.volume = 1;

        // Web Audio gain gives the call more headroom than the normal
        // HTML audio volume slider, while keeping the movie volume separate.
        try {
          const AudioContextClass =
            window.AudioContext || (window as any).webkitAudioContext;
          const audioContext =
            audioContextRef.current || new AudioContextClass();
          audioContextRef.current = audioContext;

          remoteSourceRef.current?.disconnect();
          remoteGainRef.current?.disconnect();

          const source = audioContext.createMediaStreamSource(stream);
          const gain = audioContext.createGain();
          gain.gain.value = callMuted ? 0 : callVolume * 1.6;

          source.connect(gain);
          gain.connect(audioContext.destination);
          remoteSourceRef.current = source;
          remoteGainRef.current = gain;
          audioContext.resume().catch(() => {});
        } catch (error) {
          console.warn("Web Audio boost unavailable:", error);
        }

        remoteAudioRef.current.play().catch(() => {});
      }
      setCallStatus("connected");
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") setCallStatus("connected");
      if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
        cleanupCall();
      }
    };

    return peer;
  };

  const startVoiceCall = async () => {
    if (onlineCount < 2) {
      alert("Partner belum masuk room.");
      return;
    }

    try {
      setCallStatus("calling");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        },
      });
      localStreamRef.current = stream;

      const users = Object.values(channelRef.current?.presenceState() || {}).flat() as any[];
      const partner = users.find((u) => u.user_id !== userId);

      if (!partner?.user_id) {
        cleanupCall();
        alert("Partner tidak ditemukan.");
        return;
      }

      const target = partner.user_id as string;
      const peer = await createPeer(target);
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await sendCallSignal("webrtc_offer", { target, offer });
    } catch (error: any) {
      cleanupCall();
      alert(error?.name === "NotAllowedError"
        ? "Izin microphone ditolak. Izinkan microphone di browser."
        : `Gagal memulai call: ${error?.message || "Unknown error"}`);
    }
  };

  const answerVoiceCall = async () => {
    const target = remoteUserRef.current;
    const peer = peerRef.current;
    const offer = (peer as any)?.pendingOffer;

    if (!target || !peer || !offer) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        },
      });
      localStreamRef.current = stream;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      await peer.setRemoteDescription(new RTCSessionDescription(offer));

      for (const candidate of pendingIceRef.current) {
        await peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
      pendingIceRef.current = [];

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await sendCallSignal("webrtc_answer", { target, answer });
      setCallStatus("connected");
    } catch (error: any) {
      cleanupCall();
      alert(error?.name === "NotAllowedError"
        ? "Izin microphone ditolak. Izinkan microphone di browser."
        : `Gagal menjawab call: ${error?.message || "Unknown error"}`);
    }
  };

  const toggleCallMute = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCallMuted(!track.enabled);
    if (remoteGainRef.current) {
      remoteGainRef.current.gain.value = !track.enabled ? 0 : callVolume * 1.6;
    }
  };

  const changeCallVolume = (value: number) => {
    setCallVolume(value);
    if (remoteAudioRef.current) remoteAudioRef.current.volume = 1;
    if (remoteGainRef.current) {
      remoteGainRef.current.gain.value = callMuted ? 0 : value * 1.6;
    }
  };

  const changeMovieVolume = (value: number) => {
    setMovieVolume(value);
    if (videoRef.current) {
      videoRef.current.volume = value;
      videoRef.current.muted = value === 0;
      setMuted(value === 0);
    }
  };

  // =========================
  // MOVIE VOLUME
  // =========================

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = movieVolume;
    }
  }, [movieVolume]);

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
      // WEBRTC SIGNALING
      // =========================

      .on("broadcast", { event: "webrtc_offer" }, async ({ payload }) => {
        if (!payload || payload.target !== userId) return;
        const peer = await createPeer(payload.from);
        (peer as any).pendingOffer = payload.offer;
        setCallStatus("incoming");
      })

      .on("broadcast", { event: "webrtc_answer" }, async ({ payload }) => {
        if (!payload || payload.target !== userId || !peerRef.current) return;
        await peerRef.current.setRemoteDescription(
          new RTCSessionDescription(payload.answer)
        );
        for (const candidate of pendingIceRef.current) {
          await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        }
        pendingIceRef.current = [];
        setCallStatus("connected");
      })

      .on("broadcast", { event: "webrtc_ice" }, async ({ payload }) => {
        if (!payload || payload.target !== userId) return;
        if (peerRef.current?.remoteDescription) {
          await peerRef.current.addIceCandidate(
            new RTCIceCandidate(payload.candidate)
          ).catch(() => {});
        } else {
          pendingIceRef.current.push(payload.candidate);
        }
      })

      .on("broadcast", { event: "call_end" }, async ({ payload }) => {
        if (payload?.target === userId) cleanupCall();
      })

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
      peerRef.current?.close();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
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

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await videoRef.current?.parentElement?.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch (error) {
      console.error("Fullscreen error:", error);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const leaveRoom = async () => {
    await endVoiceCall(true);
    window.location.href = "/";
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
            <button
              onClick={leaveRoom}
              className="rounded-full border border-red-400/20 bg-red-400/10 px-4 py-2 text-xs font-medium text-red-300 transition hover:bg-red-400/20"
            >
              Keluar Room
            </button>

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

                <input
                  aria-label="Movie volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={muted ? 0 : movieVolume}
                  disabled={!movieUrl}
                  onChange={(e) => changeMovieVolume(Number(e.target.value))}
                  className="w-24 accent-white"
                />

                <button
                  onClick={toggleFullscreen}
                  disabled={!movieUrl}
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm disabled:opacity-30"
                  title="Fullscreen"
                >
                  {isFullscreen ? "⛶ Exit" : "⛶ Fullscreen"}
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
            <div className="mb-4 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/30">
                Voice Call
              </p>
              <span className={`text-[11px] ${
                callStatus === "connected"
                  ? "text-green-400"
                  : callStatus === "incoming"
                    ? "text-yellow-400"
                    : "text-white/30"
              }`}>
                {callStatus === "connected" ? "● Connected"
                  : callStatus === "calling" ? "Calling..."
                  : callStatus === "incoming" ? "Incoming call"
                  : "Ready"}
              </span>
            </div>

            <audio ref={remoteAudioRef} autoPlay playsInline />

            {callStatus === "incoming" ? (
              <div className="flex gap-2">
                <button
                  onClick={answerVoiceCall}
                  className="flex-1 rounded-xl bg-white py-3 text-sm font-semibold text-black"
                >
                  📞 Answer
                </button>
                <button
                  onClick={() => endVoiceCall(true)}
                  className="rounded-xl bg-red-500/15 px-4 py-3 text-sm text-red-300"
                >
                  ✕
                </button>
              </div>
            ) : callStatus === "idle" ? (
              <button
                onClick={startVoiceCall}
                disabled={onlineCount < 2}
                className="w-full rounded-xl bg-white py-3 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-30"
              >
                📞 Call Partner
              </button>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <button
                    onClick={toggleCallMute}
                    className="flex-1 rounded-xl border border-white/10 bg-white/[0.04] py-3 text-sm"
                  >
                    {callMuted ? "🔇 Unmute" : "🎙️ Mute"}
                  </button>
                  <button
                    onClick={() => endVoiceCall(true)}
                    className="rounded-xl bg-red-500/15 px-4 py-3 text-sm text-red-300"
                  >
                    📵 End
                  </button>
                </div>

                <div>
                  <div className="mb-1 flex justify-between text-[11px] text-white/35">
                    <span>Call volume</span>
                    <span>{Math.round(callVolume * 100)}%</span>
                  </div>
                  <input
                    aria-label="Call volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={callVolume}
                    onChange={(e) => changeCallVolume(Number(e.target.value))}
                    className="w-full accent-white"
                  />
                </div>
              </div>
            )}
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