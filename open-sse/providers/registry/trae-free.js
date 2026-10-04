// Trae SOLO 远程 Agent（字节跳动 Trae）→ CreditDaddy 本地网关。
// 上游是 CreditDaddy 桌面版（techysy/CreditDaddy）的「Trae 网关」接口：
//   POST http://127.0.0.1:<port>/gateway/trae/v1/messages（Anthropic Messages 形态）
//   （网关内部转换为 https://solo.trae.cn/api/remote/v1 的 SOLO agent 会话协议）
// CreditDaddy 负责账号多路 SWRR 轮换、401 凭据热对齐、429 限流冷却与局域网白名单；
// 本条目做端点映射与模型面接入，支持思考流（thinking_delta）与用量回报。
// 前提：CreditDaddy 桌面版运行 + 面板「Trae 网关」开启 + 已添加 Trae (SOLO) 账号；
// 无账号时网关按轮换队列为空处理（503 提示）。
export default {
  id: "trae-free",
  priority: 58,
  alias: "trae-free",
  uiAlias: "trae-free",
  display: {
    name: "Trae Free",
    icon: "bolt",
    color: "#FF6A00",
    textIcon: "TF",
    website: "https://www.trae.ai",
  },
  category: "free",
  noAuth: true,
  community: true,
  // 无连接行（noAuth），注册表模型需要显式开关才会进 /v1/models ——
  // 不加此旗标会让既有 noAuth 供应商的模型自动冒出来
  exposeStaticModels: true,
  transport: {
    baseUrl: "http://127.0.0.1:47860/gateway/trae/v1/messages",
    format: "claude",
    noAuth: true,
  },
  models: [
    { id: "Doubao-Seed-2.0-Code", name: "Doubao Seed 2.0 Code" },
    { id: "Doubao-Seed-Code", name: "Doubao Seed Code" },
    { id: "minimax-m2.7", name: "MiniMax M2.7" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5v-turbo", name: "GLM 5v Turbo" },
    { id: "glm-5", name: "GLM 5" },
    { id: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" },
    { id: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "qwen-3.6-plus", name: "Qwen 3.6 Plus" },
    { id: "qwen-3.5", name: "Qwen 3.5" },
  ],
};
