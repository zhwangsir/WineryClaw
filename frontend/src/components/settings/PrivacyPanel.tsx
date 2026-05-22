/**
 * PrivacyPanel — v2.32 (P1 #8).
 *
 * UI surface for v2.17's privacy mode backend (Axis 3). When ON:
 *  - LLMRouter skips any endpoint whose base_url isn't local
 *    (127.* / 10.* / 192.168.* / LM Studio / Ollama).
 *  - User data therefore cannot leak to remote providers — even if the
 *    user's model config happens to list one.
 *
 * The toggle is persisted server-side in ~/.webrain/privacy_mode so the
 * setting survives restarts. UI just reflects + flips it.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Space, Switch, Tag, Tooltip, message } from "antd";
import { LockOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../../api/client";

interface PrivacyStatus {
  mode: "on" | "off";
  path?: string;
  local_endpoints: Array<{ name: string; base_url: string }>;
  remote_endpoints: Array<{ name: string; base_url: string }>;
}

export default function PrivacyPanel() {
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<PrivacyStatus>("/brain/privacy/status");
      setStatus(res);
    } catch (e) {
      message.error(`无法获取隐私状态: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (next: boolean) => {
      setToggling(true);
      try {
        await api.post<{ ok: boolean; mode: string }>(`/brain/privacy/toggle?mode=${next ? "on" : "off"}`);
        message.success(next ? "隐私模式已开启,仅本地 endpoint 生效" : "隐私模式已关闭");
        await refresh();
      } catch (e) {
        message.error(`切换失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setToggling(false);
      }
    },
    [refresh]
  );

  const isOn = status?.mode === "on";
  const hasLocal = (status?.local_endpoints?.length ?? 0) > 0;

  return (
    <Card
      title={
        <Space>
          <LockOutlined />
          <span>隐私模式</span>
          {status && <Tag color={isOn ? "success" : "default"}>{isOn ? "已开启" : "关闭"}</Tag>}
        </Space>
      }
      extra={
        <Tooltip title="重新获取状态">
          <Button type="text" icon={<ReloadOutlined />} loading={loading} onClick={refresh} />
        </Tooltip>
      }
      style={{ borderRadius: 12, marginBottom: 16 }}
    >
      <p style={{ marginTop: 0, color: "var(--c-text-2)" }}>
        开启后,LLMRouter 仅使用本地 endpoint(127.* / 10.* / 192.168.* / LM Studio / Ollama)。用户数据不会发送到远程
        provider,即使它们配置在模型列表中。 状态持久化到 <code>~/.webrain/privacy_mode</code>。
      </p>

      {isOn && !hasLocal && (
        <Alert
          message="警告:隐私模式开启但没有本地 endpoint"
          description="当前没有配置任何本地 LLM endpoint,所有聊天调用都会失败。请在「模型」标签下添加 LM Studio / Ollama / 局域网 endpoint。"
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      <Space direction="vertical" style={{ width: "100%" }}>
        <Space>
          <span style={{ fontWeight: 500 }}>开关:</span>
          <Switch checked={isOn} loading={toggling} onChange={toggle} checkedChildren="ON" unCheckedChildren="OFF" />
        </Space>

        {status && (
          <>
            <div style={{ marginTop: 12 }}>
              <strong>本地 endpoint ({status.local_endpoints.length}):</strong>
              {status.local_endpoints.length === 0 ? (
                <span style={{ color: "var(--c-text-3)" }}> 无</span>
              ) : (
                <ul style={{ marginTop: 4 }}>
                  {status.local_endpoints.map((ep) => (
                    <li key={ep.name}>
                      <Tag color="green">{ep.name}</Tag> <code style={{ fontSize: 12 }}>{ep.base_url}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <strong>远程 endpoint ({status.remote_endpoints.length}):</strong>
              {status.remote_endpoints.length === 0 ? (
                <span style={{ color: "var(--c-text-3)" }}> 无</span>
              ) : (
                <ul style={{ marginTop: 4 }}>
                  {status.remote_endpoints.map((ep) => (
                    <li key={ep.name}>
                      <Tag color={isOn ? "warning" : "default"}>
                        {ep.name} {isOn ? "(已屏蔽)" : ""}
                      </Tag>{" "}
                      <code style={{ fontSize: 12 }}>{ep.base_url}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </Space>
    </Card>
  );
}
