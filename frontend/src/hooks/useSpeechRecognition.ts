/**
 * Web Speech API hook (Round K6).
 *
 * Browser-native STT — no backend dependency, no API key, no network
 * round-trip after the page loads. Falls back gracefully (`supported:
 * false`) on browsers that lack `webkitSpeechRecognition` /
 * `SpeechRecognition` (Firefox today, some embedded webviews).
 *
 * Returned API:
 *   - `supported`     — whether the browser exposes SpeechRecognition
 *   - `isRecording`   — true between start() and stop()/error/end
 *   - `transcript`    — accumulated finalized text since last start()
 *   - `interim`       — what the recognizer is currently transcribing
 *                       but hasn't finalized (good for live preview)
 *   - `error`         — last error from the recognizer (null on idle)
 *   - `start(lang?)`  — begin a session; default lang "zh-CN"
 *   - `stop()`        — manually end the session
 *   - `reset()`       — clear transcript + interim
 *
 * Karpathy Rule 2: don't speculate, don't abstract. Single hook,
 * single component (ChatInput) consumes it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// SpeechRecognition isn't in lib.dom.d.ts yet on all TS versions; declare
// a minimal shim locally so we don't depend on a polyfill package.
type SR = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: ((e: Event) => void) | null;
  onend: ((e: Event) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
    length: number;
  }>;
}

interface SRCtor {
  new (): SR;
}

function getRecognitionCtor(): SRCtor | null {
  if (typeof window === "undefined") return null;
  // Chrome / Edge / Safari ship as webkitSpeechRecognition; standard
  // SpeechRecognition is unprefixed in some builds.
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseSpeechRecognitionResult {
  supported: boolean;
  isRecording: boolean;
  transcript: string;
  interim: string;
  error: string | null;
  start: (lang?: string) => void;
  stop: () => void;
  reset: () => void;
}

export function useSpeechRecognition(): UseSpeechRecognitionResult {
  const Ctor = getRecognitionCtor();
  const supported = !!Ctor;

  const recognitionRef = useRef<SR | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Build a recognition instance lazily on first start(). Recreating
  // on every start() lets the user re-record cleanly after an error.
  const ensureRecognizer = useCallback(
    (lang: string): SR | null => {
      if (!Ctor) return null;
      const r = new Ctor();
      r.lang = lang;
      r.continuous = true;
      r.interimResults = true;
      r.onstart = () => {
        setIsRecording(true);
        setError(null);
      };
      r.onend = () => {
        setIsRecording(false);
        setInterim("");
      };
      r.onerror = (e) => {
        setError(e.message || e.error || "speech recognition error");
        setIsRecording(false);
      };
      r.onresult = (e) => {
        let finalSlice = "";
        let interimSlice = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          const text = result[0]?.transcript ?? "";
          if (result.isFinal) finalSlice += text;
          else interimSlice += text;
        }
        if (finalSlice) {
          setTranscript((prev) => (prev ? prev + " " + finalSlice : finalSlice));
        }
        setInterim(interimSlice);
      };
      return r;
    },
    [Ctor]
  );

  const start = useCallback(
    (lang = "zh-CN") => {
      if (!supported || isRecording) return;
      const r = ensureRecognizer(lang);
      if (!r) return;
      recognitionRef.current = r;
      try {
        r.start();
      } catch (err) {
        // Already-started errors land here; ignore.
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [supported, isRecording, ensureRecognizer]
  );

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const reset = useCallback(() => {
    setTranscript("");
    setInterim("");
    setError(null);
  }, []);

  // Cleanup any active recognition on unmount so we don't leak the mic.
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        /* already stopped */
      }
    };
  }, []);

  return { supported, isRecording, transcript, interim, error, start, stop, reset };
}
