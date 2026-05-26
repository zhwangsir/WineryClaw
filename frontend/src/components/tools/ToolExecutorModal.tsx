import { useState, useEffect } from "react";
import { Modal, Input, Button, Switch, message } from "antd";
import { PlayCircleOutlined, CopyOutlined, CloseCircleOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { useToolStore } from "../../stores/toolStore";
import { useIsDark } from "../../hooks/useTheme";

interface Props {
  toolName: string;
  toolDescription: string;
  open: boolean;
  onClose: () => void;
}

const presets: Record<string, Record<string, unknown>> = {
  shell: { command: "echo Hello WeBrain", timeout: 30000, cwd: "." },
  file_read: { path: "./README.md", encoding: "utf-8" },
  file_write: { path: "./test-output.txt", content: "Hello from WeBrain tool test!", append: false },
  file_list: { path: ".", recursive: false },
  file_search: { pattern: "TODO", path: ".", glob: "*.ts" },
  http_request: { url: "https://api.github.com", method: "GET", headers: {}, body: "", timeout: 10000 },
  python_exec: { code: "print('Hello from WeBrain Python tool')", timeout: 30000 },
  execute_code: { script: "import os\nprint('Current dir:', os.getcwd())", filename: "test_script.py", timeout: 60000 },
  system_info: {},
  datetime: { format: "iso", timezone: "" },
  calculator: { expression: "2 + 2 * 3" },
  url_parse: { url: "https://github.com/zhwangsir/WeBrain" },
  json_parse: { text: '{"name":"WeBrain","version":"1.0.2"}', pretty: true },
};

export default function ToolExecutorModal({ toolName, toolDescription, open, onClose }: Props) {
  const isDark = useIsDark();
  const { executeTool } = useToolStore();

  const [params, setParams] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string>("");
  const [executing, setExecuting] = useState(false);
  const [newParamKey, setNewParamKey] = useState("");
  const [newParamValue, setNewParamValue] = useState("");

  useEffect(() => {
    if (open) {
      setParams({ ...(presets[toolName] || {}) });
      setResult(null);
      setError("");
    }
  }, [open, toolName]);

  const handleRun = async () => {
    setExecuting(true);
    setResult(null);
    setError("");
    try {
      const res = await executeTool(toolName, params);
      if (res.ok) {
        setResult(res.result);
        message.success("执行成功");
      } else {
        setError(res.error || "执行失败");
        message.error(res.error || "执行失败");
      }
    } catch (e: any) {
      setError(String(e.message || e));
      message.error(String(e.message || e));
    } finally {
      setExecuting(false);
    }
  };

  const updateParam = (key: string, value: unknown) => {
    setParams((p) => ({ ...p, [key]: value }));
  };

  const removeParam = (key: string) => {
    setParams((p) => {
      const copy = { ...p };
      delete copy[key];
      return copy;
    });
  };

  const addParam = () => {
    if (!newParamKey.trim()) return;
    let parsedValue: unknown = newParamValue;
    try {
      parsedValue = JSON.parse(newParamValue);
    } catch {
      // keep as string
    }
    updateParam(newParamKey.trim(), parsedValue);
    setNewParamKey("");
    setNewParamValue("");
  };

  const renderParamInput = (key: string, value: unknown) => {
    const labelStyle: React.CSSProperties = {
      fontSize: 12,
      color: "var(--c-text-3)",
      marginBottom: 4,
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    };

    if (typeof value === "boolean") {
      return (
        <div key={key} style={{ marginBottom: 12 }}>
          <div style={labelStyle}>
            <span>{key}</span>
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => removeParam(key)}
              style={{ color: "var(--c-text-3)", padding: 0, height: 20 }}
            />
          </div>
          <Switch checked={value} onChange={(v) => updateParam(key, v)} />
        </div>
      );
    }
    if (typeof value === "number") {
      return (
        <div key={key} style={{ marginBottom: 12 }}>
          <div style={labelStyle}>
            <span>{key}</span>
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => removeParam(key)}
              style={{ color: "var(--c-text-3)", padding: 0, height: 20 }}
            />
          </div>
          <Input
            type="number"
            value={value}
            onChange={(e) => updateParam(key, Number(e.target.value))}
            style={{ background: isDark ? "var(--c-hover)" : "var(--c-card)" }}
          />
        </div>
      );
    }
    if (typeof value === "object" && value !== null) {
      return (
        <div key={key} style={{ marginBottom: 12 }}>
          <div style={labelStyle}>
            <span>{key} (JSON)</span>
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => removeParam(key)}
              style={{ color: "var(--c-text-3)", padding: 0, height: 20 }}
            />
          </div>
          <Input.TextArea
            rows={3}
            value={JSON.stringify(value, null, 2)}
            onChange={(e) => {
              try {
                updateParam(key, JSON.parse(e.target.value));
              } catch {
                /* ignore invalid JSON */
              }
            }}
            style={{ background: isDark ? "var(--c-hover)" : "var(--c-card)", fontFamily: "monospace" }}
          />
        </div>
      );
    }
    return (
      <div key={key} style={{ marginBottom: 12 }}>
        <div style={labelStyle}>
          <span>{key}</span>
          <Button
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={() => removeParam(key)}
            style={{ color: "var(--c-text-3)", padding: 0, height: 20 }}
          />
        </div>
        <Input
          value={String(value ?? "")}
          onChange={(e) => updateParam(key, e.target.value)}
          style={{ background: isDark ? "var(--c-hover)" : "var(--c-card)" }}
        />
      </div>
    );
  };

  const resultJson = JSON.stringify(result, null, 2);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>测试工具: {toolName}</span>}
      width={640}
      footer={null}
      styles={{ body: { maxHeight: "70vh", overflow: "auto", padding: "20px 24px" } }}
      destroyOnHidden
    >
      <div style={{ color: "var(--c-text-2)", fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>{toolDescription}</div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14, color: "var(--c-text)" }}>参数</div>
        {Object.keys(params).length === 0 ? (
          <div style={{ color: "var(--c-text-3)", fontSize: 13, marginBottom: 12 }}>此工具暂无参数</div>
        ) : (
          Object.entries(params).map(([k, v]) => renderParamInput(k, v))
        )}

        {/* Add param */}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <Input
            placeholder="参数名"
            value={newParamKey}
            onChange={(e) => setNewParamKey(e.target.value)}
            onPressEnter={addParam}
            style={{ flex: 1, background: isDark ? "var(--c-hover)" : "var(--c-card)" }}
            size="small"
          />
          <Input
            placeholder="值（支持 JSON）"
            value={newParamValue}
            onChange={(e) => setNewParamValue(e.target.value)}
            onPressEnter={addParam}
            style={{ flex: 1.5, background: isDark ? "var(--c-hover)" : "var(--c-card)" }}
            size="small"
          />
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            onClick={addParam}
            style={{ color: "var(--c-accent)" }}
          />
        </div>
      </div>

      <Button
        type="primary"
        icon={<PlayCircleOutlined />}
        loading={executing}
        onClick={handleRun}
        block
        style={{ marginBottom: 16 }}
      >
        执行
      </Button>

      {result !== null && (
        <div style={{ position: "relative" }}>
          <div
            style={{
              fontWeight: 600,
              marginBottom: 8,
              fontSize: 14,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              color: "var(--c-text)",
            }}
          >
            <span>结果</span>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(resultJson);
                message.success("已复制");
              }}
            >
              复制
            </Button>
          </div>
          <pre
            style={{
              background: "var(--c-hover)",
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
              overflow: "auto",
              maxHeight: 240,
              border: "1px solid var(--c-border)",
              color: "var(--c-text)",
            }}
          >
            {resultJson}
          </pre>
        </div>
      )}

      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            fontSize: 13,
            padding: 12,
            background: "var(--c-error-bg)",
            borderRadius: 8,
            border: "1px solid var(--c-error)",
          }}
        >
          <CloseCircleOutlined style={{ color: "var(--c-error)", fontSize: 16, marginTop: 1, flexShrink: 0 }} />
          <span style={{ color: "var(--c-text)", lineHeight: 1.5 }}>{error}</span>
        </div>
      )}
    </Modal>
  );
}
