// StepFun 阶跃星辰开放平台 — dual-protocol (OpenAI Chat Completions + native
// Anthropic Messages, docs 2026-09): base https://api.stepfun.com/v1 with
// Bearer API key from platform.stepfun.com/interface-key.
//
// Image generation is being retired upstream: /v1/images/{generations,
// image2image,edits} and both image models stop serving on 2026-10-10
// (official notice docs/zh/guides/image-offline-notice). We ship it anyway
// (user decision B) with the deadline stamped into the display names so the
// rows self-explain once they go dark.
//
// step-router-v1 is deliberately absent: Step Plan channel only.
//
// Models are cleanly partitioned by kind:
//   - LLM (chat/vision): step-5-preview, step-3.7-flash, step-3.5-flash(-2603), step-1o-turbo-vision
//   - Image: step-image-edit-2, step-2x-large (kind: "image", managed under media-providers/image)
//   - TTS: stepaudio-3-tts, stepaudio-2.5-tts, step-tts-2, step-tts-mini (kind: "tts", under media-providers/tts)
//   - STT: stepaudio-2.5-asr (kind: "stt", under media-providers/stt)
//
// Conversational audio models (stepaudio-2.5-chat, step-audio-2, etc.) and
// realtime WebSocket endpoints are omitted so they do not pollute the LLM picker.
export default {
  id: "stepfun",
  priority: 65,
  alias: "stepfun",
  aliases: ["step"],
  display: {
    name: "StepFun",
    icon: "bolt",
    color: "#2E5BFF",
    textIcon: "SF",
    website: "https://platform.stepfun.com",
    notice: {
      apiKeyUrl: "https://platform.stepfun.com/interface-key",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.stepfun.com/v1/chat/completions",
    validateUrl: "https://api.stepfun.com/v1/models",
  },
  models: [
    { id: "step-5-preview", name: "Step 5 Preview" },
    { id: "step-3.7-flash", name: "Step 3.7 Flash" },
    { id: "step-3.5-flash", name: "Step 3.5 Flash" },
    { id: "step-3.5-flash-2603", name: "Step 3.5 Flash 2603" },
    { id: "step-1o-turbo-vision", name: "Step-1o Turbo Vision" },
    { id: "step-image-edit-2", name: "Step Image Edit 2（2026-10-10 下线）", params: ["size", "n"], kind: "image" },
    { id: "step-2x-large", name: "Step 2X Large（2026-10-10 下线）", params: ["size", "n"], kind: "image" },
    { id: "stepaudio-3-tts", name: "StepAudio 3 TTS", kind: "tts" },
    { id: "stepaudio-2.5-tts", name: "StepAudio 2.5 TTS", kind: "tts" },
    { id: "step-tts-2", name: "Step TTS 2", kind: "tts" },
    { id: "step-tts-mini", name: "Step TTS Mini", kind: "tts" },
    { id: "stepaudio-2.5-asr", name: "StepAudio 2.5 ASR", kind: "stt" },
  ],
  serviceKinds: ["llm", "imageToText", "image", "tts", "stt"],
  features: {
    usage: true,
    usageApikey: true,
  },
  imageConfig: {
    baseUrl: "https://api.stepfun.com/v1/images/generations",
    // Upstream ignores/rejects unknown keys; size formats differ per model
    // (image-edit-2 wants HxW!) — pass the common subset through, server
    // defaults cover steps/cfg_scale/seed for the 20-day remainder.
    bodyFields: ["model", "prompt", "n", "size", "response_format"],
  },
  // OpenAI-compatible TTS. Voice is a required upstream field; clients encode
  // it in the model string ("stepaudio-2.5-tts/cixingnansheng", the router-wide
  // convention), and defaultVoice covers a bare model id. 磁性男声 is the voice
  // used throughout the official examples; "alloy" (generic fallback) 400s.
  ttsConfig: {
    baseUrl: "https://api.stepfun.com/v1/audio/speech",
    authType: "apikey",
    authHeader: "bearer",
    format: "openai",
    defaultVoice: "cixingnansheng",
  },
  // Multipart Whisper-compatible transcription (model + file + response_format;
  // stepaudio-2.5-asr is the doc-recommended current name, step-asr legacy alias
  // not listed to avoid a deprecated row).
  sttConfig: {
    baseUrl: "https://api.stepfun.com/v1/audio/transcriptions",
    authType: "apikey",
    authHeader: "bearer",
    format: "openai",
  },
};
