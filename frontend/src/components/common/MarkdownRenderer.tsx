import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus, vs } from "react-syntax-highlighter/dist/esm/styles/prism";
import { CopyOutlined, CheckOutlined } from "@ant-design/icons";
import { Tooltip, message } from "antd";
import { useIsDark } from "../../hooks/useTheme";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function CodeBlock({
  className,
  children,
  ...props
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const isDark = useIsDark();
  const [copied, setCopied] = useState(false);

  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";
  const code = String(children).replace(/\n$/, "");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error("复制失败");
    }
  };

  // react-markdown v10 no longer passes inline prop — detect by language class presence.
  // Code without a language-* className (inline backtick) renders as <code>, not <div>.
  if (!match) {
    return (
      <code
        className={className}
        style={{
          background: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
          padding: "2px 6px",
          borderRadius: 4,
          fontSize: "0.9em",
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          color: isDark ? "#f5f5f5" : "#000000",
        }}
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <div style={{ position: "relative", margin: "8px 0" }}>
      {/* Code header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 12px",
          background: isDark ? "#1a1a2e" : "#f0f0f0",
          borderRadius: "8px 8px 0 0",
          border: `1px solid ${isDark ? "#27272a" : "#e5e5e5"}`,
          borderBottom: "none",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: isDark ? "#a1a1aa" : "#666666",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          {lang || "text"}
        </span>
        <Tooltip title={copied ? "已复制" : "复制代码"}>
          <button
            onClick={handleCopy}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
              display: "flex",
              alignItems: "center",
              color: copied ? "var(--c-success)" : isDark ? "#a1a1aa" : "#666666",
              fontSize: 13,
              transition: "color 150ms",
            }}
          >
            {copied ? <CheckOutlined /> : <CopyOutlined />}
          </button>
        </Tooltip>
      </div>
      <SyntaxHighlighter
        style={isDark ? vscDarkPlus : vs}
        language={lang || "text"}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: "0 0 8px 8px",
          fontSize: 13,
          lineHeight: 1.6,
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          overflowX: "auto",
        }}
        {...props}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

export default function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const isDark = useIsDark();

  const components = useMemo(
    () => ({
      code: CodeBlock,
      p({ children }: { children?: React.ReactNode }) {
        return <p style={{ margin: "0.5em 0", lineHeight: 1.7 }}>{children}</p>;
      },
      ul({ children }: { children?: React.ReactNode }) {
        return <ul style={{ margin: "0.5em 0", paddingLeft: 20 }}>{children}</ul>;
      },
      ol({ children }: { children?: React.ReactNode }) {
        return <ol style={{ margin: "0.5em 0", paddingLeft: 20 }}>{children}</ol>;
      },
      li({ children }: { children?: React.ReactNode }) {
        return <li style={{ margin: "0.25em 0" }}>{children}</li>;
      },
      h1({ children }: { children?: React.ReactNode }) {
        return (
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0.8em 0 0.4em", lineHeight: 1.3 }}>{children}</h1>
        );
      },
      h2({ children }: { children?: React.ReactNode }) {
        return (
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: "0.7em 0 0.35em", lineHeight: 1.3 }}>{children}</h2>
        );
      },
      h3({ children }: { children?: React.ReactNode }) {
        return (
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0.6em 0 0.3em", lineHeight: 1.3 }}>{children}</h3>
        );
      },
      blockquote({ children }: { children?: React.ReactNode }) {
        return (
          <blockquote
            style={{
              margin: "0.5em 0",
              padding: "8px 16px",
              borderLeft: `3px solid ${isDark ? "#3f3f46" : "#d4d4d8"}`,
              background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
              borderRadius: "0 6px 6px 0",
              color: isDark ? "#a1a1aa" : "#666666",
            }}
          >
            {children}
          </blockquote>
        );
      },
      table({ children }: { children?: React.ReactNode }) {
        return (
          <div style={{ overflowX: "auto", margin: "0.5em 0" }}>
            <table
              style={{
                borderCollapse: "collapse",
                width: "100%",
                fontSize: 13,
                border: `1px solid ${isDark ? "#27272a" : "#e5e5e5"}`,
                borderRadius: 6,
              }}
            >
              {children}
            </table>
          </div>
        );
      },
      thead({ children }: { children?: React.ReactNode }) {
        return <thead style={{ background: isDark ? "#1f1f1f" : "#f5f5f5" }}>{children}</thead>;
      },
      th({ children }: { children?: React.ReactNode }) {
        return (
          <th
            style={{
              padding: "8px 12px",
              textAlign: "left",
              fontWeight: 600,
              fontSize: 12,
              borderBottom: `1px solid ${isDark ? "#27272a" : "#e5e5e5"}`,
              color: isDark ? "#a1a1aa" : "#666666",
            }}
          >
            {children}
          </th>
        );
      },
      td({ children }: { children?: React.ReactNode }) {
        return (
          <td
            style={{
              padding: "8px 12px",
              borderBottom: `1px solid ${isDark ? "#27272a" : "#e5e5e5"}`,
            }}
          >
            {children}
          </td>
        );
      },
      hr() {
        return (
          <hr
            style={{
              border: "none",
              borderTop: `1px solid ${isDark ? "#27272a" : "#e5e5e5"}`,
              margin: "1em 0",
            }}
          />
        );
      },
      a({ children, href }: { children?: React.ReactNode; href?: string }) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "var(--c-accent)",
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            {children}
          </a>
        );
      },
      img({ src, alt }: { src?: string; alt?: string }) {
        return (
          <img
            src={src}
            alt={alt}
            style={{
              maxWidth: "100%",
              borderRadius: 8,
              margin: "0.5em 0",
            }}
          />
        );
      },
    }),
    [isDark]
  );

  const remarkPlugins = useMemo(() => [remarkGfm], []);

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
