import React, { useState, useEffect, useRef } from "react";
import { Mic, MicOff, PhoneOff, Video, Languages, AudioLines, Maximize, RotateCw, ScreenShare, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

export default function App() {
  const [isTalking, setIsTalking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [callStatus, setCallStatus] = useState("Idle");
  const [transcript, setTranscript] = useState("");
  const [currentAiResponse, setCurrentAiResponse] = useState("");
  const [timer, setTimer] = useState(0);
  const [callActive, setCallActive] = useState(false);
  const [showCaptions, setShowCaptions] = useState(true);
  const [isAiVoiceEnabled, setIsAiVoiceEnabled] = useState(true);
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [volume, setVolume] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const userVideoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Queue system for streaming TTS
  const speechQueue = useRef<string[]>([]);
  const isProcessingQueue = useRef(false);
  const lastSpokenIndex = useRef(0);
  const isAiStreaming = useRef(false);
  const silenceTimerRef = useRef<number | null>(null);
  const isRecordingStarted = useRef(false);

  const isTalkingRef = useRef(isTalking);
  const isAiThinkingRef = useRef(isAiThinking);
  const callActiveRef = useRef(callActive);

  useEffect(() => { isTalkingRef.current = isTalking; }, [isTalking]);
  useEffect(() => { isAiThinkingRef.current = isAiThinking; }, [isAiThinking]);
  useEffect(() => { callActiveRef.current = callActive; }, [callActive]);

  // Initialize Audio Recording for STT (Replaces browser-native SpeechRecognition to avoid beep)
  useEffect(() => {
    // Auto-start call to remove home screen
    startCall();

    return () => {
      stopListening();
    };
  }, []); // Only once on mount

  const startListening = async () => {
    if (isRecordingStarted.current || !callActiveRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyserRef.current = analyser;

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (audioChunksRef.current.length > 0) {
          const mimeType = mediaRecorder.mimeType || "audio/webm";
          const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
          await handleAudioBlob(audioBlob);
        }
      };

      mediaRecorder.start();
      isRecordingStarted.current = true;
      setIsListening(true);
      setCallStatus("Listening...");

      // SIMPLE VAD (Voice Activity Detection)
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      let lastSpeakTime = Date.now();
      let isUserTalking = false;

      const checkVolume = () => {
        if (!isRecordingStarted.current) return;
        
        analyser.getByteFrequencyData(dataArray);
        const sum = dataArray.reduce((a, b) => a + b, 0);
        const average = sum / bufferLength;
        setVolume(average);

        // THRESHOLD: 15 is a decent value for ambient noise
        if (average > 15) {
          if (!isUserTalking) {
            // BARGE-IN: User started talking
            if (isTalkingRef.current || isAiThinkingRef.current || isAiStreaming.current) {
              stopAiSpeechAndThinking();
            }
          }
          isUserTalking = true;
          lastSpeakTime = Date.now();
        } else {
          // Silence detected
          if (isUserTalking && Date.now() - lastSpeakTime > 1200) {
            // User finished talking (1.2s silence)
            isUserTalking = false;
            stopAndProcess();
          }
        }

        if (isRecordingStarted.current) requestAnimationFrame(checkVolume);
      };

      requestAnimationFrame(checkVolume);

      const stopAndProcess = () => {
        if (mediaRecorder.state !== "inactive") {
          mediaRecorder.stop();
          isRecordingStarted.current = false;
          setIsListening(false);
          // Restart will happen after processing or if forced
        }
      };

    } catch (err) {
      console.error("Mic access denied or error:", err);
      setCallStatus("Mic Access Denied");
    }
  };

  const stopListening = () => {
    isRecordingStarted.current = false;
    setIsListening(false);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
  };

  const handleAudioBlob = async (blob: Blob) => {
    setCallStatus("Transcribing...");
    const formData = new FormData();
    const extension = blob.type.includes("mp4") ? "m4a" : "webm";
    formData.append("audio", blob, `recording.${extension}`);

    try {
      const response = await fetch("/api/stt", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (data.text && data.text.trim().length > 1) {
        setTranscript(data.text);
        handleUserSpeech(data.text);
      } else {
        // Just resumed listening if nothing was heard
        if (callActiveRef.current && !isTalkingRef.current && !isAiThinkingRef.current) {
           startListening();
        }
      }
    } catch (error) {
      console.error("STT Error:", error);
      if (callActiveRef.current) startListening();
    }
  };

  useEffect(() => {
    if (callActive) {
      timerIntervalRef.current = window.setInterval(() => {
        setTimer((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      setTimer(0);
    }
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, [callActive]);

  const startCamera = async (mode: "user" | "environment" = facingMode) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: mode }, 
        audio: true 
      });
      streamRef.current = stream;
      if (userVideoRef.current) {
        userVideoRef.current.srcObject = stream;
      }
      setIsScreenSharing(false);
    } catch (err) {
      console.warn("Camera/Mic access denied:", err);
    }
  };

  const toggleCamera = () => {
    const newMode = facingMode === "user" ? "environment" : "user";
    setFacingMode(newMode);
    stopCamera();
    startCamera(newMode);
  };

  const startScreenShare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      streamRef.current = stream;
      if (userVideoRef.current) {
        userVideoRef.current.srcObject = stream;
      }
      setIsScreenSharing(true);
      
      // Stop screenshare if user clicks "Stop sharing" in browser UI
      stream.getVideoTracks()[0].onended = () => {
        setIsScreenSharing(false);
        startCamera();
      };
    } catch (err) {
      console.warn("Screen share denied:", err);
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const stopAiSpeechAndThinking = () => {
    // 1. Abort Groq stream
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // 2. Clear Speech Queue
    speechQueue.current = [];
    isAiStreaming.current = false;
    isProcessingQueue.current = false;
    
    // 3. Stop TTS
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    
    // 4. Update UI
    setIsTalking(false);
    setIsAiThinking(false);
    setCallStatus("Listening...");
  };

  const handleUserSpeech = async (message: string) => {
    if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
    
    setCallStatus("Thinking...");
    setIsAiThinking(true);
    setCurrentAiResponse("");
    speechQueue.current = [];
    lastSpokenIndex.current = 0;
    isAiStreaming.current = true;

    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) throw new Error("Backend connection failed");
      
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No reader available");

      let fullText = "";
      const decoder = new TextDecoder();
      setIsAiThinking(false);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") break;

            try {
              const { content } = JSON.parse(dataStr);
              fullText += content;
              setCurrentAiResponse(fullText);

              // Sentence-level streaming for TTS
              const currentBatch = fullText.slice(lastSpokenIndex.current);
              const pauseMatches = currentBatch.match(/[.?!](\s|$)/);
              
              if (pauseMatches) {
                const nextIndex = lastSpokenIndex.current + (pauseMatches.index || 0) + 2;
                const chunkToSpeak = fullText.slice(lastSpokenIndex.current, nextIndex).trim();
                
                if (chunkToSpeak.length > 3) {
                  speechQueue.current.push(chunkToSpeak);
                  lastSpokenIndex.current = nextIndex;
                  processSpeechQueue();
                }
              }
            } catch (e) {
              console.warn("Failed to parse chunk", e);
            }
          }
        }
      }
      
      // Handle any remaining text at the end
      const finalBatch = fullText.slice(lastSpokenIndex.current).trim();
      if (finalBatch.length > 0) {
        speechQueue.current.push(finalBatch);
        processSpeechQueue();
      }

      if (!fullText) {
        startListening();
      }
    } catch (error: any) {
      if (error.name === "AbortError") {
        return; // Silently ignore deliberate abortions (barge-in)
      }
      console.error("Groq Error:", error);
      setCallStatus("Reconnecting...");
      const msg = "I'm listening, tell me more.";
      setCurrentAiResponse(msg);
      speechQueue.current.push(msg);
      processSpeechQueue();
    } finally {
      isAiStreaming.current = false;
      processSpeechQueue();
    }
  };

  const processSpeechQueue = async () => {
    if (isProcessingQueue.current || speechQueue.current.length === 0) return;
    
    isProcessingQueue.current = true;
    while (speechQueue.current.length > 0) {
      const text = speechQueue.current.shift();
      if (text) {
        setCallStatus("AI Speaking...");
        await speak(text);
      }
    }
    isProcessingQueue.current = false;
    
    // Once everything is spoken AND streaming is done, start listening again
    if (callActive && !isAiStreaming.current && speechQueue.current.length === 0) {
      setCallStatus("Listening...");
      setTranscript("");
      startListening();
    }
  };

  const speak = async (text: string) => {
    if (!isAiVoiceEnabled) return;

    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) throw new Error("TTS failed");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }

      const audio = new Audio(url);
      audioRef.current = audio;

      return new Promise<void>((resolve) => {
        audio.onplay = () => {
          setIsTalking(true);
          if (videoRef.current) {
            videoRef.current.currentTime = 0;
            videoRef.current.play().catch(e => console.warn("Video play failed:", e));
          }
        };

        audio.onended = () => {
          setIsTalking(false);
          if (videoRef.current) {
            videoRef.current.pause();
            videoRef.current.currentTime = 0;
          }
          URL.revokeObjectURL(url);
          resolve();
        };

        audio.onerror = () => {
          setIsTalking(false);
          URL.revokeObjectURL(url);
          resolve();
        };

        audio.play().catch(err => {
          console.error("Audio play failed:", err);
          setIsTalking(false);
          resolve();
        });
      });
    } catch (error) {
      console.error("Speak Error:", error);
      setIsTalking(false);
    }
  };

  const startCall = () => {
    setCallActive(true);
    setCallStatus("Connected");
    startCamera();
    setTranscript("");
    setCurrentAiResponse("");
    setTimeout(() => startListening(), 1000);
  };

  const endCall = () => {
    setCallActive(false);
    setCallStatus("Disconnected");
    stopCamera();
    stopListening();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setIsTalking(false);
    setIsListening(false);
    setTranscript("");
    setCurrentAiResponse("");
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden font-sans text-white select-none">
      {/* Background Image / Idle State */}
      <img
        src="/131007.png"
        alt="AI Companion"
        onError={(e) => {
          const target = e.target as HTMLImageElement;
          const fallback = "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=100&w=1440";
          if (target.src !== fallback) target.src = fallback;
        }}
        className={`absolute inset-0 w-full h-full object-cover transition-all duration-1000 ${
          isTalking ? "scale-105 brightness-110" : "scale-100 brightness-100"
        }`}
        referrerPolicy="no-referrer"
      />

      {/* Breathing glow effect */}
      <div className={`absolute inset-0 z-10 pointer-events-none transition-opacity duration-1000 ${callActive ? 'opacity-100' : 'opacity-0'}`}>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vw] h-[80vw] rounded-full bg-blue-500/5 blur-[120px] animate-breathing" />
      </div>

      {/* Talking State Video */}
      <video
        ref={videoRef}
        src="/131084.mp4"
        loop
        playsInline
        muted
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-1000 z-0 pointer-events-none ${
          isTalking ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Overlay UI Container */}
      <div className="absolute inset-0 z-20 flex flex-col justify-between p-6 bg-gradient-to-b from-black/60 via-transparent to-black/80 pointer-events-none">
        
        {/* Top Header */}
        <div className="flex justify-between items-start pt-safe">
          <div className="flex flex-col gap-0.5">
            <h1 className="text-2xl font-semibold tracking-tight text-white/90 drop-shadow-lg">Humsafar</h1>
            <div className="flex items-center gap-2">
              {callActive && (
                <div className="flex items-center bg-white/10 backdrop-blur-3xl px-3 py-1 rounded-full gap-2 border border-white/10">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                  <span className="text-[11px] font-mono font-medium tracking-wider text-white/80">{formatTime(timer)}</span>
                </div>
              )}
              <span className="text-xs font-medium text-white/50">{callStatus}</span>
            </div>
          </div>

          {callActive && isTalking && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-white/10 backdrop-blur-2xl rounded-full p-2 border border-white/10 flex items-center gap-2 px-4 pointer-events-auto"
              >
                <div className="speaking-wave">
                  <span /> <span /> <span /> <span /> <span />
                </div>
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-80">AI Talking</span>
              </motion.div>
          )}
        </div>

        {/* User Self-Preview (PIP) - Repositioned to Bottom Right */}
        <AnimatePresence>
          {callActive && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.8, x: 20, y: 20 }}
              animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="absolute bottom-32 right-6 w-32 h-48 rounded-2xl overflow-hidden glass-panel shadow-2xl z-40 bg-black pointer-events-auto"
            >
              <video
                ref={userVideoRef}
                autoPlay
                muted
                playsInline
                className={`w-full h-full object-cover opacity-90 ${facingMode === 'user' ? 'mirror' : ''}`}
              />
              <div className="absolute inset-0 border border-white/10 rounded-2xl pointer-events-none" />
              
              {/* Rotate Button in Corner of Video PIP */}
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCamera();
                }}
                className="absolute top-2 right-2 p-2 bg-black/40 backdrop-blur-md rounded-full hover:bg-black/60 transition-colors border border-white/10"
              >
                <RotateCw className="w-4 h-4 text-white" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Accept Call UI - (Now hidden as we auto-start, but kept for logic if needed) */}
        {false && !callActive && (
          <div className="w-full flex-1 flex flex-col items-center justify-center pointer-events-auto pb-safe">
            <motion.div 
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full flex flex-col items-center px-6"
            >
              <div className="relative group mb-8">
                <div className="absolute -inset-1 bg-gradient-to-r from-emerald-600 to-teal-500 rounded-full blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200" />
                <div className="relative w-24 h-24 bg-emerald-500 rounded-full flex items-center justify-center shadow-2xl shadow-emerald-500/20">
                  <Video className="w-10 h-10 text-white" />
                </div>
              </div>
              
              <h2 className="text-3xl font-bold mb-12 text-white/90 tracking-tight">Humsafar AI</h2>
              
              <div className="w-full max-w-sm glass-panel rounded-[40px] p-8 flex justify-between items-center px-10">
                <div className="flex flex-col items-center gap-3">
                  <button 
                    className="w-14 h-14 bg-red-500 rounded-full flex items-center justify-center hover:bg-red-600 transition-all hover:scale-110 active:scale-95 shadow-xl shadow-red-500/20"
                  >
                    <PhoneOff className="w-6 h-6 text-white" />
                  </button>
                  <span className="text-[10px] font-bold tracking-widest opacity-40 uppercase">Decline</span>
                </div>

                <div className="flex flex-col items-center gap-3">
                  <button 
                    onClick={startCall}
                    className="w-18 h-18 bg-emerald-500 rounded-full flex items-center justify-center hover:bg-emerald-600 animate-pulse transition-all hover:scale-110 active:scale-95 shadow-xl shadow-emerald-500/30"
                  >
                    <Video className="w-9 h-9 text-white" />
                  </button>
                  <span className="text-[10px] font-bold tracking-widest opacity-40 uppercase">Accept</span>
                </div>

                <div className="flex flex-col items-center gap-3">
                  <button 
                    className="w-14 h-14 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20 transition-all hover:scale-110 active:scale-95"
                  >
                    <Languages className="w-6 h-6 text-white" />
                  </button>
                  <span className="text-[10px] font-bold tracking-widest opacity-40 uppercase">Text</span>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {/* Active Call Interaction Layer */}
        <div className="flex flex-col gap-4">
          {/* Subtitle / Speech Bubble - Moved to Left Above Controls */}
          <AnimatePresence>
            {callActive && showCaptions && (transcript || currentAiResponse) && (
              <motion.div 
                initial={{ opacity: 0, x: -20, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -20 }}
                className="self-start ml-2 mb-2 glass-panel px-6 py-4 rounded-[28px_28px_28px_4px] max-w-[70vw] relative group pointer-events-auto"
              >
                  {isTalking && (
                      <div className="absolute -top-1 -right-1">
                          <span className="flex h-3 w-3">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                          </span>
                      </div>
                  )}
                <p className="text-white text-sm font-medium italic leading-relaxed tracking-wide shadow-black/20 drop-shadow-sm">
                  {callStatus === "Thinking..." && !currentAiResponse ? (
                    <span className="flex gap-1 items-center py-1">
                      <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce [animation-delay:-0.3s]" />
                      <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce [animation-delay:-0.15s]" />
                      <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" />
                    </span>
                  ) : (
                    isTalking ? (currentAiResponse || "...") : (transcript || "...")
                  )}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Redesigned Controls Bar - Thinner, 5 buttons */}
          {callActive && (
            <div className="w-full flex justify-center pointer-events-auto pb-safe">
              <motion.div 
                initial={{ y: 50, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="w-full max-w-xl glass-panel rounded-[32px] p-2 px-4 flex justify-between items-center shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
              >
                {/* Mute */}
                <button 
                  onClick={() => isListening ? stopListening() : startListening()}
                  className={`w-11 h-11 flex items-center justify-center rounded-full transition-all ${isListening ? "bg-white text-black shadow-lg" : "bg-white/10 text-white hover:bg-white/20"}`}
                >
                  {isListening ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
                </button>

                {/* AI Voice Toggle */}
                <button 
                  onClick={() => setIsAiVoiceEnabled(!isAiVoiceEnabled)}
                  className={`w-11 h-11 flex items-center justify-center rounded-full transition-all ${isAiVoiceEnabled ? "bg-blue-500/40 text-blue-200 border border-blue-500/30" : "bg-white/10 text-white/60"}`}
                >
                  <AudioLines className="w-5 h-5" />
                </button>

                {/* End Call - Centered, Slightly Larger */}
                <button 
                  onClick={endCall}
                  className="w-14 h-14 bg-red-600 hover:bg-red-700 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-[0_4px_15px_rgba(220,38,38,0.4)]"
                >
                  <PhoneOff className="w-7 h-7 text-white" />
                </button>

                {/* Screen Mirroring Button */}
                <button 
                  onClick={startScreenShare}
                  className={`w-11 h-11 flex items-center justify-center rounded-full transition-all ${isScreenSharing ? "bg-emerald-500/40 text-emerald-200 border border-emerald-500/30" : "bg-white/10 text-white hover:bg-white/20"}`}
                >
                  <ScreenShare className="w-5 h-5" />
                </button>

                {/* Video Option / Toggle Camera */}
                <button 
                  onClick={toggleCamera}
                  className="w-11 h-11 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-all"
                >
                  <RotateCw className="w-5 h-5 text-white" />
                </button>
              </motion.div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
