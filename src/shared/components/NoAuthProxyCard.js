"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [gatewayHost, setGatewayHost] = useState("");
  const [gatewayPort, setGatewayPort] = useState("");
  const [gatewayPath, setGatewayPath] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setRotateStrategy(override.rotateStrategy || "none");
      setGatewayHost(providerId === "zcode-free" ? settingsData.zcodeGatewayHost || "" : "");
      setGatewayPort(providerId === "zcode-free" ? settingsData.zcodeGatewayPort || "" : "");
      setGatewayPath(providerId === "zcode-free" ? settingsData.zcodeGatewayPath || "" : "");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const save = useCallback(async (poolId, strategy) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") delete override.rotateStrategy;
      else override.rotateStrategy = strategy;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId]);

  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy);
  };

  // zcode-free: CreditDaddy 网关主机（本机留空 = 127.0.0.1；局域网填 IP；端口留空 = 47860）
  const saveGatewayHost = useCallback(async (host, port, reqPath) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const patch = {
        zcodeGatewayHost: String(host || "").trim(),
        zcodeGatewayPort: String(port || "").trim(),
        zcodeGatewayPath: String(reqPath || "").trim(),
      };
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save gateway host error:", e);
    } finally {
      setSaving(false);
    }
  }, []);

  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handlePoolChange(e.target.value)}
        disabled={saving || isRotation}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
        hint={isRotation ? "Pool selector is ignored when rotation is active — all active pools are used." : undefined}
      />

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text-main">Rotation Strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving}
          className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value} disabled={s.value !== "none" && !canRotate}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">
          {!canRotate
            ? `Need at least 2 active proxy pools for rotation.`
            : isRotation
              ? rotateStrategy === "round-robin"
                ? `Rotating through all ${proxyPools.length} active pools in order. State is in-memory (resets on restart).`
                : `Picking a random pool from ${proxyPools.length} active pools each request.`
              : `Uses the selected pool above. Set to Round-robin or Random to rotate across all active pools.`}
        </p>
      </div>
      {providerId === "zcode-free" && (
        <div className="flex flex-col gap-2 mt-4 pt-4 border-t border-black/5 dark:border-white/5">
          <label className="text-sm font-medium text-text-main">CreditDaddy 网关主机</label>
          <div className="flex gap-2">
            <input
              value={gatewayHost}
              onChange={(e) => setGatewayHost(e.target.value)}
              placeholder="留空 = 本机 127.0.0.1；局域网填 CreditDaddy 主机 IP"
              className="flex-1 py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <input
              value={gatewayPort}
              onChange={(e) => setGatewayPort(e.target.value)}
              placeholder="47860"
              className="w-24 py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <input
              value={gatewayPath}
              onChange={(e) => setGatewayPath(e.target.value)}
              placeholder="/gateway/v1/messages"
              className="w-44 py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <button
              onClick={() => saveGatewayHost(gatewayHost, gatewayPort, gatewayPath)}
              disabled={saving}
              className="px-3 py-2 text-sm rounded-md bg-primary text-white disabled:opacity-50"
            >
              保存
            </button>
          </div>
          <p className="text-xs text-text-muted">
            CreditDaddy 桌面版开启「额度网关」后即为本机可用；局域网主机需在其面板开启「局域网」并重启。
            远程主机需鉴权——建一个带 key 的连接（key = 其「10Router 连接设置」里的虚拟 key）。
          </p>
        </div>
      )}
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
