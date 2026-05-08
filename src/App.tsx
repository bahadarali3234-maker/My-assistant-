import React, { useState, useEffect, useRef } from "react";
import { Mic, MicOff, PhoneOff, Video, Maximize } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default function App() {
  const [isTalking, setIsTalking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [callStatus, setCallStatus] = useState("Idle");
  const [transcript, setTranscript] = useState("");
  const [timer, setTimer] = useState(0);
  const [callActive, setCallActive] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const userVideoRef = useRef<HTMLVideoElement>(null);
  const recognitionRef = useRef<any>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Initialize Speech Recognition
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-US";

      recognition.onresult = (event: any) => {
        const text = event.results[0][0].transcript;
        setTranscript(text);
        handleUserSpeech(text);
      };

      recognition.onerror = (event: any) => {
        console.error("Speech Recognition Error:", event.error);
        setIsListening(false);
        setCallStatus("Mic Error");
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }
  }, []);

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

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (userVideoRef.current) {
        userVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.warn("Camera access denied:", err);
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const startListening = () => {
    if (recognitionRef.current && !isListening && !isTalking && callActive) {
      try {
        recognitionRef.current.start();
        setIsListening(true);
        setCallStatus("Listening...");
      } catch (e) {
        console.warn("Recognition already started");
      }
    }
  };

  const handleUserSpeech = async (message: string) => {
    setCallStatus("AI Thinking...");
    try {
      // Using 'gemini-flash-latest' as it's the most reliable fallback.
      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: message,
        config: {
          temperature: 0.7,
          systemInstruction: "You are a friendly companion named Gemini on a FaceTime call. Keep responses short (10-15 words), warm, and natural. No emojis. Just conversational text."
        }
      });

      const text = response.text;
      
      if (text) {
        speak(text.trim());
      } else {
        startListening();
      }
    } catch (error) {
      console.error("Gemini Error:", error);
      const backups = ["That's interesting, tell me more!", "I'm listening, go on.", "Oh, I see what you mean."];
      const msg = backups[Math.floor(Math.random() * backups.length)];
      setTimeout(() => speak(msg), 400);
    }
  };

  const speak = (text: string) => {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      
      const utterance = new SpeechSynthesisUtterance(text);
      
      // Try to find a female voice for better personality
      const voices = window.speechSynthesis.getVoices();
      const femaleVoice = voices.find(v => (v.name.includes("Female") || v.name.includes("Google US English")) && v.lang.startsWith("en"));
      if (femaleVoice) utterance.voice = femaleVoice;

      utterance.onstart = () => {
        setIsTalking(true);
        setCallStatus("AI Speaking...");
        if (videoRef.current) {
          videoRef.current.currentTime = 0;
          videoRef.current.play().catch(e => console.warn("Video play failed:", e));
        }
      };

      utterance.onend = () => {
        setIsTalking(false);
        setCallStatus("Listening...");
        if (videoRef.current) {
          videoRef.current.pause();
          videoRef.current.currentTime = 0;
        }
        if (callActive) {
          setTimeout(() => startListening(), 400);
        }
      };

      utterance.onerror = (event) => {
        console.error("Speech Synthesis Error:", event.error);
        setIsTalking(false);
        if (videoRef.current) {
          videoRef.current.pause();
          videoRef.current.currentTime = 0;
        }
        if (callActive) {
          startListening();
        }
      };

      window.speechSynthesis.speak(utterance);
    }
  };

  const startCall = () => {
    setCallActive(true);
    setCallStatus("Connected");
    startCamera();
    setTimeout(() => startListening(), 1000);
  };

  const endCall = () => {
    setCallActive(false);
    setCallStatus("Disconnected");
    stopCamera();
    if (recognitionRef.current) recognitionRef.current.stop();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setIsTalking(false);
    setIsListening(false);
    setTranscript("");
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

      {/* Talking State Video */}
      <video
        ref={videoRef}
        src="/131084.mp4"
        loop
        playsInline
        muted
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-1000 pointer-events-none ${
          isTalking ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* User Self-Preview (PIP) */}
      <motion.div 
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: callActive ? 1 : 0, scale: callActive ? 1 : 0.8 }}
        className="absolute top-10 right-6 w-32 h-44 rounded-2xl overflow-hidden glass shadow-2xl border border-white/10 z-40 bg-black/20 backdrop-blur-xl"
      >
        <video
          ref={userVideoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover mirror"
        />
      </motion.div>

      {/* Pulse effect overlay for talk/listen states - enhanced to look like active interaction */}
      <div 
        className={`absolute inset-0 pointer-events-none transition-all duration-500 ${
          isTalking 
            ? "bg-green-500/10 shadow-[inner_0_0_100px_rgba(34,197,94,0.2)] opacity-100" 
            : "bg-transparent opacity-0"
        }`}
      >
        {isTalking && (
          <div className="absolute bottom-1/3 left-1/2 -translate-x-1/2 w-32 h-1 bg-green-400/50 blur-xl animate-pulse" />
        )}
      </div>

      {/* Overlay UI */}
      <div className="absolute inset-0 flex flex-col justify-between p-6 bg-gradient-to-b from-black/50 via-transparent to-black/70 pointer-events-none">
        
        {/* Top Header */}
        <div className="flex justify-between items-start pt-safe">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-medium tracking-tight opacity-90">FaceTime</h1>
            <div className="flex items-center gap-2">
              {callActive && (
                <div className="flex items-center bg-white/20 backdrop-blur-md px-3 py-1 rounded-full gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-xs font-mono font-medium tracking-wider">{formatTime(timer)}</span>
                </div>
              )}
              <span className="text-sm font-medium opacity-70">{callStatus}</span>
            </div>
          </div>
          
          <div className="flex gap-4 pointer-events-auto">
            <button className="p-3 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-xl border border-white/5 transition-colors">
              <Maximize className="w-5 h-5 text-white" />
            </button>
          </div>
        </div>

        {/* Center UI (Accept Call) */}
        {!callActive && (
          <div className="flex flex-col items-center gap-8 pointer-events-auto">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center"
            >
              <div className="w-20 h-20 bg-green-500 rounded-full mx-auto mb-6 flex items-center justify-center shadow-2xl shadow-green-500/20">
                <Video className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-2xl font-semibold mb-10 text-white">Incoming FaceTime</h2>
              <div className="flex gap-16">
                <div className="flex flex-col items-center gap-3">
                  <button 
                    onClick={() => {}} 
                    className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center hover:bg-red-600 transition-colors shadow-lg"
                  >
                    <PhoneOff className="w-7 h-7 text-white" />
                  </button>
                  <span className="text-xs opacity-60">Decline</span>
                </div>
                <div className="flex flex-col items-center gap-3">
                  <button 
                    onClick={startCall}
                    className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center hover:bg-green-600 animate-bounce transition-colors shadow-lg"
                  >
                    <Video className="w-7 h-7 text-white" />
                  </button>
                  <span className="text-xs opacity-60">Accept</span>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {/* Dynamic Controls Bar */}
        <AnimatePresence>
          {callActive && transcript && (
            <motion.div 
              initial={{ opacity: 0, y: 10, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="self-center mb-8 bg-black/40 backdrop-blur-3xl px-6 py-4 rounded-[30px] border border-white/5 max-w-[80vw] text-center"
            >
              <p className="text-white/80 font-light italic leading-relaxed">"{transcript}"</p>
            </motion.div>
          )}
        </AnimatePresence>

        {callActive && (
          <div className="flex flex-col items-center gap-10 pointer-events-auto pb-10">
            <div className="bg-white/10 backdrop-blur-[60px] border border-white/10 rounded-[50px] p-4 flex items-center gap-10 shadow-[0_30px_60px_rgba(0,0,0,0.4)]">
              <button 
                onClick={() => isListening ? recognitionRef.current?.stop() : startListening()}
                className={`p-5 rounded-full transition-all ${isListening ? "bg-white text-black scale-110" : "bg-white/10 text-white hover:bg-white/20"}`}
              >
                {isListening ? <Mic className="w-7 h-7" /> : <MicOff className="w-7 h-7" />}
              </button>

              <button 
                onClick={endCall}
                className="p-8 bg-red-600 hover:bg-red-500 rounded-full shadow-2xl transition-all hover:scale-110 active:scale-95"
              >
                <PhoneOff className="w-10 h-10 text-white" />
              </button>

              <button className="p-5 rounded-full bg-white/10 hover:bg-white/20 transition-all">
                <Video className="w-7 h-7 text-white" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Ripple Effect when listening */}
      <AnimatePresence>
        {isListening && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 pointer-events-none border-[3px] border-emerald-500/20"
          >
            <div className="absolute inset-0 animate-pulse bg-emerald-500/5" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
