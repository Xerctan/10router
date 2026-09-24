import { describe, it, expect, vi, beforeEach } from "vitest";

// GET /api/usage/quotas — aggregated, read-only quota overview (CreditDaddy integration).

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  computeConnectionUsage: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: mocks.getProviderConnections }));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: { claude: { name: "Claude Code" }, glm: { name: "GLM" } },
  USAGE_APIKEY_PROVIDERS: ["glm"],
}));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  computeConnectionUsage: mocks.computeConnectionUsage,
}));

const CONNS = [
  { id: "c1", provider: "claude", authType: "oauth", name: "work", email: "a@x.com", isActive: true, accessToken: "SECRET-AT", refreshToken: "SECRET-RT" },
  { id: "c2", provider: "glm", authType: "apikey", name: "glm key", isActive: false, apiKey: "SECRET-KEY" },
  { id: "c3", provider: "openai", authType: "apikey", name: "no usage api", apiKey: "SECRET-2" },
];

async function load() {
  vi.resetModules();
  return import("../../src/app/api/usage/quotas/route.js");
}
const req = (q = "") => ({ url: `http://localhost/api/usage/quotas${q}` });

describe("GET /api/usage/quotas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(CONNS);
    mocks.computeConnectionUsage.mockImplementation(async (c) => (c.id === "c1"
      ? { status: 200, body: { plan: "Max", quotas: { "session (5h)": { used: 30, total: 100, resetAt: "2026-09-24T10:00:00Z" } } } }
      : { status: 401, body: { error: "Credential refresh failed: expired" } }));
  });

  it("lists only usage-capable connections, normalized, without credentials", async () => {
    const { GET } = await load();
    const data = await (await GET(req())).json();
    expect(data.connections.map((c) => c.id)).toEqual(["c1", "c2"]);   // c3: apikey provider without a usage API
    const [claude, glm] = data.connections;
    expect(claude).toMatchObject({ provider: "claude", providerName: "Claude Code", name: "work", email: "a@x.com", plan: "Max", isActive: true, cached: false });
    expect(claude.quotas[0]).toMatchObject({ name: "session (5h)", used: 30, total: 100 });
    expect(glm).toMatchObject({ providerName: "GLM", isActive: false, error: "Credential refresh failed: expired", quotas: [] });
    expect(JSON.stringify(data)).not.toMatch(/SECRET/);
  });

  it("caches per connection; ?force=1 bypasses the cache", async () => {
    const { GET } = await load();
    await GET(req());
    expect(mocks.computeConnectionUsage).toHaveBeenCalledTimes(2);
    const again = await (await GET(req())).json();
    expect(mocks.computeConnectionUsage).toHaveBeenCalledTimes(2);
    expect(again.connections.every((c) => c.cached)).toBe(true);
    await GET(req("?force=1"));
    expect(mocks.computeConnectionUsage).toHaveBeenCalledTimes(4);
    expect(mocks.computeConnectionUsage).toHaveBeenLastCalledWith(expect.anything(), { force: true });
  });

  it("a throwing connection becomes an error entry instead of failing the overview", async () => {
    mocks.computeConnectionUsage.mockRejectedValueOnce(new Error("boom"));
    const { GET } = await load();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connections.find((c) => c.error === "boom")).toBeTruthy();
  });
});
