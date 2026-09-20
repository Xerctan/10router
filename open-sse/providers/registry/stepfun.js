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
// stepaudio chat models are text-out but audio-in first-class; not wired as
// plain text chat rows to avoid half-working picker entries.
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
  ],
  serviceKinds: ["llm", "imageToText", "image"],
  imageConfig: {
    baseUrl: "https://api.stepfun.com/v1/images/generations",
    // Upstream ignores/rejects unknown keys; size formats differ per model
    // (image-edit-2 wants HxW!) — pass the common subset through, server
    // defaults cover steps/cfg_scale/seed for the 20-day remainder.
    bodyFields: ["model", "prompt", "n", "size", "response_format"],
  },
};
