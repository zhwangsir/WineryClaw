import { useEffect } from "react";
import { Descriptions } from "antd";
import { useSystemStore } from "../../stores/systemStore";

export default function AboutPanel() {
  const { health, fetchHealth } = useSystemStore();

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  const modules = health?.modules || {};

  return (
    <div style={{ maxWidth: 600 }}>
      <Descriptions
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>WeBrain</span>}
        bordered
        column={1}
        size="small"
        style={{ marginBottom: 32 }}
      >
        <Descriptions.Item label="版本">
          <span style={{ color: "var(--c-text-2)", fontWeight: 300 }}>1.0.2</span>
        </Descriptions.Item>
        <Descriptions.Item label="构建时间">
          <span style={{ color: "var(--c-text-2)", fontWeight: 300 }}>2026-05-06</span>
        </Descriptions.Item>
        <Descriptions.Item label="许可证">
          <span style={{ color: "var(--c-text-2)", fontWeight: 300 }}>MIT</span>
        </Descriptions.Item>
        <Descriptions.Item label="仓库">
          <a
            href="https://github.com/zhwangsir/WeBrain"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--c-accent)", fontWeight: 400 }}
          >
            github.com/zhwangsir/WeBrain
          </a>
        </Descriptions.Item>
      </Descriptions>

      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 16, color: "var(--c-text)" }}>系统状态</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {Object.entries(modules).map(([name, active]) => (
          <div
            key={name}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "12px 16px",
              borderRadius: 10,
              background: "var(--c-card)",
              border: "1px solid var(--c-border)",
            }}
          >
            <span style={{ color: "var(--c-text)", fontSize: 14, fontWeight: 400 }}>{name}</span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 400,
                padding: "2px 10px",
                borderRadius: 6,
                background: active ? "var(--c-success)" : "var(--c-error)",
                color: "#ffffff",
              }}
            >
              {active ? "正常" : "异常"}
            </span>
          </div>
        ))}
        {Object.keys(modules).length === 0 && (
          <div style={{ color: "var(--c-text-3)", fontWeight: 300 }}>暂无状态信息</div>
        )}
      </div>
    </div>
  );
}
