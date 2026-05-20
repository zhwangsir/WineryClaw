/**
 * ApiTokenPanel — Round N2.
 *
 * When sub-brain is started with `WEBRAIN_API_TOKEN=...`, every /api/*
 * and /brain/* request must carry `Authorization: Bearer <token>` (or
 * `x-webrain-token: <token>`). The shared axios client at
 * `frontend/src/api/client.ts` already injects the token from
 * `localStorage["webrain-api-key"]`, so this panel is just the
 * end-user interface for setting that key without DevTools.
 *
 * Off by default — when WEBRAIN_API_TOKEN is unset on the server side,
 * unauthenticated requests succeed and this panel is purely cosmetic.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Input, Space, Tag, Tooltip, message } from "antd";
import { SafetyOutlined, EyeOutlined, EyeInvisibleOutlined, ReloadOutlined } from "@ant-design/icons";

const STORAGE_KEY = "webrain-api-key";

export default function ApiTokenPanel() {
  const [stored, setStored] = useState<string>(() => {
    // O5: read localStorage synchronously on first render so `stored` is
    // never empty when probe() first fires from the mount effect below.
    // The old useEffect-based init meant probe() captured stored="" via
    // closure and always reported "denied" / "unset" on first paint.
    try {
      return localStorage.getItem(STORAGE_KEY) || "";
    } catch {
      return "";
    }
  });
  const [draft, setDraft] = useState<string>(stored);
  const [reveal, setReveal] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<"unset" | "ok" | "denied" | null>(null);

  /** Probe sub-brain to see whether auth is enabled and whether the
   *  currently-stored token (if any) actually works.
   *  O5: takes the token as an explicit argument so callers can pass
   *  the freshly-saved value without waiting for a render cycle. */
  const probe = useCallback(async (tokenOverride?: string) => {
    setProbing(true);
    try {
      // Read localStorage fresh (don't rely on captured `stored`) so
      // re-probes after save() see the new value without a state lag.
      const token = tokenOverride !== undefined
        ? tokenOverride
        : (() => {
            try {
              return localStorage.getItem(STORAGE_KEY) || "";
            } catch {
              return "";
            }
          })();
      const resp = await fetch("/api/sandbox/status", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (resp.status === 401) setProbeResult("denied");
      else if (resp.ok) setProbeResult("ok");
      else setProbeResult("unset");
    } catch {
      setProbeResult("unset");
    } finally {
      setProbing(false);
    }
  }, []);

  // Probe once on mount. Empty dep array is correct: probe() is stable
  // (useCallback with []), and the first probe should fire exactly once.
  useEffect(() => {
    probe();
  }, [probe]);

  const save = () => {
    try {
      if (draft) localStorage.setItem(STORAGE_KEY, draft);
      else localStorage.removeItem(STORAGE_KEY);
      setStored(draft);
      message.success(draft ? "API Token 已保存" : "API Token 已清除");
      // Re-probe with the fresh value rather than relying on the captured
      // `stored` state which hasn't updated yet (still the previous value).
      probe(draft);
    } catch (e: any) {
      message.error(e?.message || "保存失败");
    }
  };

  const dirty = draft !== stored;

  return (
    <Card
      title={
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
          <SafetyOutlined />
          API Token
          <Tag style={{ marginLeft: 4, fontSize: 11, fontWeight: 400 }} color="processing">
            N2
          </Tag>
        </span>
      }
      style={{ marginTop: 16, borderRadius: 12, border: "1px solid var(--c-border)" }}
      bodyStyle={{ padding: 24 }}
    >
      <Alert
        type={probeResult === "denied" ? "error" : probeResult === "ok" ? "success" : "info"}
        showIcon
        style={{ marginBottom: 16 }}
        message={
          probeResult === "denied"
            ? "sub-brain 已开启鉴权,但当前 Token 错误或未设置 — 请输入正确的 Token"
            : probeResult === "ok"
              ? stored
                ? "sub-brain 已开启鉴权,当前 Token 验证通过"
                : "sub-brain 未开启鉴权 (WEBRAIN_API_TOKEN 未设置)"
              : "正在探测 sub-brain 鉴权状态…"
        }
        action={
          <Button
            size="small"
            icon={<ReloadOutlined spin={probing} />}
            onClick={() => probe()}
            disabled={probing}
          >
            重测
          </Button>
        }
      />

      <div style={{ fontSize: 13, color: "var(--c-text-2)", marginBottom: 10 }}>
        前端会把这个 Token 作为 <code>Authorization: Bearer &lt;token&gt;</code> 注入所有 API 请求。 sub-brain
        启动时设置 <code>WEBRAIN_API_TOKEN=&lt;一致的值&gt;</code> 即可启用。 留空 = 关闭客户端注入。
      </div>

      <Space.Compact style={{ width: "100%", marginBottom: 12 }}>
        <Input
          type={reveal ? "text" : "password"}
          placeholder="例如 sk-webrain-abc123  (留空清除)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={save}
          autoComplete="off"
          spellCheck={false}
          style={{ fontFamily: "monospace" }}
        />
        <Tooltip title={reveal ? "隐藏" : "显示"}>
          <Button icon={reveal ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={() => setReveal((v) => !v)} />
        </Tooltip>
      </Space.Compact>

      <div style={{ display: "flex", gap: 8 }}>
        <Button type="primary" disabled={!dirty} onClick={save}>
          {draft ? "保存" : "清除"}
        </Button>
        {dirty && <Button onClick={() => setDraft(stored)}>取消修改</Button>}
      </div>

      <div style={{ fontSize: 11, color: "var(--c-text-3)", marginTop: 14, lineHeight: 1.6 }}>
        Token 仅保存在你的浏览器 <code>localStorage["webrain-api-key"]</code>,不会上传到任何远程服务器。
        多设备使用需在每个浏览器分别设置。
      </div>
    </Card>
  );
}
