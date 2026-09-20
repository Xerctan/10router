// StepFun 阶跃星辰开放平台 · 中国站（api.stepfun.com）。按量计费渠道：扣账户现金
// / 赠送代金券（GET /v1/accounts 可查）。走订阅套餐 Credit 的是兄弟渠道
// stepfun-plan-cn（/step_plan/v1）；国际站同构命名为 stepfun / stepfun-plan
// （api.stepfun.ai）。两条通道 Base URL 不同、额度互不影响。
//
// dual-protocol（OpenAI Chat Completions + 原生 Anthropic Messages，docs 2026-09）：
// base https://api.stepfun.com/v1，Bearer API key 取自 platform.stepfun.com/interface-key。
//
// 图像生成上游正在下线：/v1/images/{generations,image2image,edits} 与两个图像模型
// 将于 2026-10-10 停止服务（官方公告 docs/zh/guides/image-offline-notice）。仍照常入库
// （用户决策 B），把下线日期写进展示名，让行在下线后自解释。
//
// step-router-v1 故意不在本渠道：它只在 Step Plan 渠道提供。
//
// 模型按 kind 严格分区：
//   - LLM（chat/vision）：step-5-preview, step-3.7-flash, step-3.5-flash(-2603), step-1o-turbo-vision
//   - Image：step-image-edit-2, step-2x-large（kind: "image"，归 media-providers/image）
//   - TTS：stepaudio-3-tts, stepaudio-2.5-tts, step-tts-2, step-tts-mini（kind: "tts"，归 media-providers/tts）
//   - STT：stepaudio-2.5-asr（kind: "stt"，归 media-providers/stt）
//
// 对话式音频模型（stepaudio-2.5-chat、step-audio-2 等）与 realtime WebSocket 端点
// 均不入库，避免污染纯 LLM 选择器。
export default {
  id: "stepfun-cn",
  priority: 65,
  alias: "stepfun-cn",
  display: {
    name: "StepFun CN",
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
