/**
 * STT Tool — Speech-to-Text via local Whisper
 * Falls back to system whisper CLI if available
 */

import { registry, ToolDefinition } from "./tool-registry.js";
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const sttDef: ToolDefinition = {
  name: "stt",
  description: "Transcribe audio to text using local Whisper. Supports MP3/WAV/M4A/WebM.",
  category: "media",
  parameters: [
    { name: "audio_path", type: "string", description: "Path to audio file", required: true },
    { name: "language", type: "string", description: "Language code (e.g. zh, en, auto)", default: "auto" },
    { name: "model", type: "string", description: "Whisper model: tiny, base, small, medium, large", default: "base" },
  ],
};

async function sttExecute(params: Record<string, unknown>) {
  const audioPath = String(params.audio_path || "");
  const language = String(params.language || "auto");
  const model = String(params.model || "base");

  if (!audioPath || !existsSync(audioPath)) {
    return { error: `Audio file not found: ${audioPath}` };
  }

  // Check if whisper CLI is available
  try {
    execSync("which whisper", { encoding: "utf-8", timeout: 5000 });
  } catch (err) { console.error("[stt-tool] Error:", err);
    return {
      error: "Whisper CLI not found. Install with: pip install openai-whisper",
      hint: "Or use: brew install openai-whisper (macOS)",
    };
  }

  try {
    const outputDir = join(homedir(), ".webrain", "stt-output");
    mkdirSync(outputDir, { recursive: true });

    const cmd = [
      "whisper",
      `"${audioPath}"`,
      `--model ${model}`,
      language !== "auto" ? `--language ${language}` : "",
      `--output_dir "${outputDir}"`,
      "--output_format json",
    ]
      .filter(Boolean)
      .join(" ");

    execSync(cmd, { encoding: "utf-8", timeout: 300000 }); // 5 min max for large files

    // Read the JSON output
    const baseName = audioPath.split("/").pop()?.replace(/\.[^.]+$/, "") || "audio";
    const jsonPath = join(outputDir, `${baseName}.json`);

    if (existsSync(jsonPath)) {
      const { readFileSync } = await import("fs");
      const json = JSON.parse(readFileSync(jsonPath, "utf-8"));
      return {
        text: json.text || "",
        segments: (json.segments || []).map((s: any) => ({
          start: s.start,
          end: s.end,
          text: s.text,
        })),
        language: json.language || language,
        model,
      };
    }

    return { error: "Whisper produced no output" };
  } catch (err: any) {
    return { error: `STT failed: ${err.message}` };
  }
}

// ─── Registration ────────────────────────────────────────────────

export function registerSttTool(): void {
  registry.register(sttDef, sttExecute);
}
