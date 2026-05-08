import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import multer from "multer";
import fs from "fs";
import * as googleTTS from "google-tts-api";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const groq = new Groq({
  apiKey: process.env.GROK_API_KEY || process.env.GROQ_API_KEY,
});

const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `${file.fieldname}-${Date.now()}${ext}`);
  },
});

const upload = multer({ storage });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  
  app.post("/api/tts", async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Text is required" });

    try {
      // Use google-tts-api as Edge TTS is blocked (403) from this environment
      const url = googleTTS.getAudioUrl(text, {
        lang: "ur",
        slow: false,
        host: "https://translate.google.com",
      });
      
      // Redirect to the Google TTS URL
      res.redirect(url);
    } catch (error: any) {
      console.error("TTS Error:", error.message || error);
      res.status(500).json({ error: "TTS failed", details: error.message || error });
    }
  });

  app.post("/api/stt", upload.single("audio"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    try {
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(req.file.path),
        model: "whisper-large-v3",
      });

      // Simple cleanup
      fs.unlinkSync(req.file.path);

      res.json({ text: transcription.text });
    } catch (error: any) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      console.error("STT Error:", error.message);
      res.status(500).json({ error: "Transcription failed" });
    }
  });

  app.post("/api/chat", async (req, res) => {
    const { message } = req.body;
    
    if (!process.env.GROQ_API_KEY && !process.env.GROK_API_KEY) {
      return res.status(500).json({ error: "API Key is not configured" });
    }

    try {
      const stream = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "You are Humsafar, a friendly and intelligent companion on a FaceTime call. You are fluent in English and Urdu. Respond naturally in the language the user uses. Keep responses short (10-15 words), warm, and spontaneous. No emojis. Just conversational text.",
          },
          {
            role: "user",
            content: message,
          },
        ],
        model: "llama-3.3-70b-versatile",
        stream: true,
        temperature: 0.8,
        max_tokens: 156,
      });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error: any) {
      console.error("Groq API Error:", error.message);
      res.status(500).json({ error: "Failed to connect to AI" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
