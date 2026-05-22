/**
 * RAGUploadDropzone — v2.34 (P1 #10).
 *
 * Drag-and-drop region that uploads files to ~/.webrain/uploads/ and
 * chains into /brain/rag/index_file. Solves the "user must type
 * absolute path" UX gap in RAGPage.
 *
 * Behavior:
 *   - Drop one or more files → for each: upload → index
 *   - Per-file progress entries show in a list (queued → uploading → indexed)
 *   - Failed files stay in the list with error reason — user can clear
 *   - Native file picker available too (click region)
 *   - Refreshes parent stats on every successful index via onIndexed callback
 *
 * The component is opinionated about file size: anything > 10 MB triggers
 * an Alert because base64 over JSON struggles past that (Vite proxy default
 * body limit is 100 MB — fine for most docs, but 50+ MB would block the
 * UI for many seconds during base64 encode).
 */
import { useCallback, useRef, useState } from "react";
import { Alert, Button, List, Space, Tag, Tooltip, Upload, message } from "antd";
import { DeleteOutlined, InboxOutlined } from "@ant-design/icons";
import type { UploadProps } from "antd";
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  uploadApi,
  validateUploadCandidate,
} from "../../api/upload";

const { Dragger } = Upload;

type FileState = "queued" | "uploading" | "indexing" | "done" | "failed";

interface FileItem {
  id: string;
  name: string;
  size: number;
  state: FileState;
  chunks?: number;
  error?: string;
}

interface Props {
  /** Called whenever a file completes (success OR fail). Parent can
   * use this to refresh RAG stats / document list. */
  onIndexed?: () => void;
}

/** Soft UX warning (>10 MB blocks UI during base64 encode); the hard
 * reject lives in MAX_UPLOAD_BYTES. */
const SIZE_WARN_MB = 10;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function stateTag(s: FileState, chunks?: number): React.ReactNode {
  switch (s) {
    case "queued":
      return <Tag>排队</Tag>;
    case "uploading":
      return <Tag color="processing">上传中</Tag>;
    case "indexing":
      return <Tag color="processing">索引中</Tag>;
    case "done":
      return <Tag color="success">完成{chunks != null ? ` · ${chunks} chunks` : ""}</Tag>;
    case "failed":
      return <Tag color="error">失败</Tag>;
  }
}

export default function RAGUploadDropzone({ onIndexed }: Props) {
  const [items, setItems] = useState<FileItem[]>([]);
  // Counter used only to give each FileItem a stable id (incrementing
  // never wraps in practice — even rapid drops won't exceed Number.MAX).
  const counter = useRef(0);
  const [showSizeWarn, setShowSizeWarn] = useState(false);

  const updateItem = useCallback((id: string, patch: Partial<FileItem>) => {
    setItems((arr) => arr.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const processOne = useCallback(
    async (file: File) => {
      const id = `f${counter.current++}`;
      const newItem: FileItem = {
        id,
        name: file.name,
        size: file.size,
        state: "queued",
      };
      setItems((arr) => [newItem, ...arr]);

      updateItem(id, { state: "uploading" });
      try {
        const res = await uploadApi.uploadAndIndex(file);
        if (!res.upload.ok) {
          updateItem(id, { state: "failed", error: res.upload.error || "上传失败" });
          message.error(`${file.name}: ${res.upload.error || "上传失败"}`);
          onIndexed?.();
          return;
        }
        // upload succeeded; check index step
        if (!res.indexed) {
          updateItem(id, {
            state: "failed",
            error: res.error || "索引失败(文件已保存)",
          });
          message.warning(`${file.name}: 上传成功但索引失败 — ${res.error}`);
          onIndexed?.();
          return;
        }
        updateItem(id, { state: "done", chunks: res.chunks });
        message.success(`${file.name} 已索引(${res.chunks ?? 0} chunks)`);
        onIndexed?.();
      } catch (e) {
        updateItem(id, {
          state: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
        onIndexed?.();
      }
    },
    [onIndexed, updateItem]
  );

  // The Upload component would auto-POST to a URL we set in `action`,
  // but we want to use OUR uploadApi (which goes through the axios
  // client with auth + retry). So we intercept via `beforeUpload` and
  // return false to suppress the built-in POST.
  //
  // v2.38: pre-check the file BEFORE enqueueing so we don't waste a
  // round-trip on doomed uploads. The backend has its own authoritative
  // gate (uploads-routes ALLOWED_EXTENSIONS + MAX_UPLOAD_BYTES) — this
  // client check is purely for fast feedback. A file rejected here is
  // surfaced both as a transient antd message AND a persistent failed
  // FileItem so the user can see the reason in the list.
  const draggerProps: UploadProps = {
    name: "file",
    multiple: true,
    showUploadList: false,
    // antd's `accept` adds the OS-native extension filter to the file
    // picker — joined with comma. This is purely UX; the real gate is
    // in validateUploadCandidate below.
    accept: [...ALLOWED_UPLOAD_EXTENSIONS].sort().join(","),
    beforeUpload: async (file) => {
      const reason = validateUploadCandidate(file as File);
      if (reason) {
        // Surface the failure as a list item so it's not lost when the
        // antd `message` toast auto-dismisses after a few seconds.
        const id = `f${counter.current++}`;
        setItems((arr) => [
          {
            id,
            name: file.name,
            size: file.size,
            state: "failed",
            error: reason,
          },
          ...arr,
        ]);
        message.error(`${file.name}: ${reason}`);
        return false;
      }
      if (file.size > SIZE_WARN_MB * 1024 * 1024) {
        setShowSizeWarn(true);
      }
      void processOne(file as File);
      return false; // prevent default upload
    },
  };

  return (
    <div>
      {showSizeWarn && (
        <Alert
          message="检测到 >10MB 文件"
          description="大文件的 base64 编码会暂时阻塞 UI 几秒。如需索引超大文档,建议改用「批量索引目录」直接指向源路径。"
          type="warning"
          showIcon
          closable
          onClose={() => setShowSizeWarn(false)}
          style={{ marginBottom: 12 }}
        />
      )}

      <Dragger {...draggerProps} style={{ padding: "16px 0", marginBottom: 12 }}>
        <p className="ant-upload-drag-icon" style={{ color: "var(--c-accent)" }}>
          <InboxOutlined />
        </p>
        <p className="ant-upload-text" style={{ fontWeight: 500 }}>
          拖拽文件到这里或点击选择
        </p>
        {/* v2.38: RAG indexer reads files as UTF-8 text. Binary formats
            (.pdf .docx .xlsx 等) 会被读成乱码,索引出来全是替换字符。
            正确做法是只列出真实有效的文本格式;若要真正支持 PDF,需要先在
            indexer 里接 pdfplumber/python-docx 解析器,然后扩展两端
            allowlist (前端 ALLOWED_UPLOAD_EXTENSIONS + 后端
            ALLOWED_EXTENSIONS)。 */}
        <p className="ant-upload-hint" style={{ fontSize: 12, color: "var(--c-text-3)" }}>
          支持 .txt / .md / .json / .csv / 源代码 等文本格式 — 单文件最大{" "}
          {Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB,保存到 ~/.webrain/uploads/ 并自动索引
        </p>
      </Dragger>

      {items.length > 0 && (
        <List
          size="small"
          bordered
          dataSource={items}
          locale={{ emptyText: "暂无上传记录" }}
          renderItem={(it) => (
            <List.Item
              actions={[
                <Tooltip key="del" title="从列表移除(不删服务器文件)">
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={() => setItems((arr) => arr.filter((x) => x.id !== it.id))}
                  />
                </Tooltip>,
              ]}
            >
              <Space style={{ flex: 1, justifyContent: "space-between", width: "100%" }}>
                <Space>
                  {stateTag(it.state, it.chunks)}
                  <span style={{ fontWeight: 500 }}>{it.name}</span>
                  <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{fmtSize(it.size)}</span>
                </Space>
                {it.error && (
                  <Tooltip title={it.error}>
                    <span
                      style={{
                        fontSize: 11,
                        color: "#b91c1c",
                        maxWidth: 280,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {it.error}
                    </span>
                  </Tooltip>
                )}
              </Space>
            </List.Item>
          )}
        />
      )}
    </div>
  );
}
