/**
 * Builtin MCP server catalog — popular Model Context Protocol servers
 * recommended for local AI workflows. Surface to the frontend via
 * GET /mcp/catalog. Clicking "Install" in McpPage triggers POST /mcp/connect
 * with the matching config — spawns the server via `npx -y <pkg>` and
 * registers its tools.
 *
 * All entries use stdio transport (the MCP spec's default) and rely on
 * `npx` for zero-install onboarding. Where a server needs a secret
 * (e.g. GITHUB_PERSONAL_ACCESS_TOKEN), `requiredEnv` lists the variable
 * name so the UI can prompt before connecting.
 */
export interface BuiltinMCPCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: "files" | "dev" | "data" | "web" | "ai" | "system";
  command: string;
  args: string[];
  type: "stdio";
  /** Required env vars (e.g. API keys) the user must set before connecting. */
  requiredEnv?: string[];
  /** Hint about what to pass as a path/arg when the server needs one. */
  pathArgHint?: string;
  /** Estimated download size on first npx run (MB). */
  sizeEstimateMb?: number;
  homepage?: string;
}

export const BUILTIN_MCP_CATALOG: BuiltinMCPCatalogEntry[] = [
  {
    id: "builtin-filesystem",
    name: "Filesystem",
    description:
      "Read/write local files and directories. Sandboxed to a root directory you pass at startup.",
    category: "files",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}"],
    type: "stdio",
    pathArgHint: "Replace ${HOME} with the allowed root dir before connecting.",
    sizeEstimateMb: 20,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "builtin-memory",
    name: "Memory (Knowledge Graph)",
    description:
      "Persistent knowledge-graph memory store. AI can create entities, relations, and recall facts across sessions.",
    category: "ai",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    type: "stdio",
    sizeEstimateMb: 15,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "builtin-sequential-thinking",
    name: "Sequential Thinking",
    description:
      "Step-by-step reasoning tool. AI emits structured thoughts that can be revised, branched, and verified.",
    category: "ai",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    type: "stdio",
    sizeEstimateMb: 10,
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "builtin-fetch",
    name: "Fetch (Web)",
    description:
      "Fetch web pages, return clean Markdown. Useful for AI reading articles, docs, etc.",
    category: "web",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    type: "stdio",
    sizeEstimateMb: 15,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "builtin-puppeteer",
    name: "Puppeteer (Browser)",
    description:
      "Headless Chrome control: navigate, click, screenshot, evaluate JS. Heavy on first install (~250MB).",
    category: "web",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    type: "stdio",
    sizeEstimateMb: 250,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
  },
  {
    id: "builtin-github",
    name: "GitHub",
    description:
      "Access GitHub repos, issues, PRs, releases. Requires a personal access token.",
    category: "dev",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    type: "stdio",
    requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    sizeEstimateMb: 25,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
  },
  {
    id: "builtin-gitlab",
    name: "GitLab",
    description:
      "Access GitLab projects, issues, MRs. Requires a personal access token.",
    category: "dev",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gitlab"],
    type: "stdio",
    requiredEnv: ["GITLAB_PERSONAL_ACCESS_TOKEN", "GITLAB_API_URL"],
    sizeEstimateMb: 20,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab",
  },
  {
    id: "builtin-postgres",
    name: "PostgreSQL",
    description:
      "Query PostgreSQL databases — read-only queries are safest. Requires a connection string.",
    category: "data",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "${POSTGRES_URL}"],
    type: "stdio",
    requiredEnv: ["POSTGRES_URL"],
    pathArgHint: "Replace ${POSTGRES_URL} with postgres://user:pass@host:5432/dbname.",
    sizeEstimateMb: 30,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
  },
  {
    id: "builtin-sqlite",
    name: "SQLite",
    description:
      "Query SQLite database files locally. Pass the .db path at startup.",
    category: "data",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite", "${SQLITE_DB_PATH}"],
    type: "stdio",
    pathArgHint: "Replace ${SQLITE_DB_PATH} with the absolute path to your .db file.",
    sizeEstimateMb: 15,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
  },
  {
    id: "builtin-brave-search",
    name: "Brave Search",
    description:
      "Web search via Brave's API. Requires a free API key from brave.com.",
    category: "web",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    type: "stdio",
    requiredEnv: ["BRAVE_API_KEY"],
    sizeEstimateMb: 12,
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
  },
  {
    id: "builtin-google-drive",
    name: "Google Drive",
    description:
      "Read & search Google Drive files. Requires Google OAuth credentials.",
    category: "files",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    type: "stdio",
    requiredEnv: ["GDRIVE_CLIENT_ID", "GDRIVE_CLIENT_SECRET"],
    sizeEstimateMb: 40,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive",
  },
  {
    id: "builtin-time",
    name: "Time",
    description:
      "Time zone conversion + current time queries. No setup needed.",
    category: "system",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-time"],
    type: "stdio",
    sizeEstimateMb: 8,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
  },
  {
    id: "builtin-slack",
    name: "Slack",
    description: "Read and post Slack messages. Requires a bot token + team ID.",
    category: "dev",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    type: "stdio",
    requiredEnv: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
    sizeEstimateMb: 25,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
  },
  {
    id: "builtin-everart",
    name: "EverArt (Image Gen)",
    description: "Generate images via EverArt's API. Requires an API key.",
    category: "ai",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everart"],
    type: "stdio",
    requiredEnv: ["EVERART_API_KEY"],
    sizeEstimateMb: 18,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/everart",
  },
];
