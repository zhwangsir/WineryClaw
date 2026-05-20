import { Suspense, lazy, useEffect } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { GlobalProgressBar } from "./components/common/GlobalProgress";
import { useSystemStore } from "./stores/systemStore";
import { useAgentStore } from "./stores/agentStore";
import { useToolStore } from "./stores/toolStore";
import { useChannelStore } from "./stores/channelStore";
import { useChatStore } from "./stores/chatStore";
import { Loading } from "./components/common/Loading";

const UserHomePage = lazy(() => import("./pages/UserHomePage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const ChatPage = lazy(() => import("./pages/ChatPage"));
const AgentsPage = lazy(() => import("./pages/AgentsPage"));
const ToolsPage = lazy(() => import("./pages/ToolsPage"));
const PluginsPage = lazy(() => import("./pages/PluginsPage"));
const SkillsPage = lazy(() => import("./pages/SkillsPage"));
const MemoryPage = lazy(() => import("./pages/MemoryPage"));
const WikiPage = lazy(() => import("./pages/WikiPage"));
const KnowledgeGraphPage = lazy(() => import("./pages/KnowledgeGraphPage"));
const ChannelsPage = lazy(() => import("./pages/ChannelsPage"));
const CronPage = lazy(() => import("./pages/CronPage"));
const TemplatesPage = lazy(() => import("./pages/TemplatesPage"));
const WorkflowsPage = lazy(() => import("./pages/WorkflowsPage"));
const SandboxPage = lazy(() => import("./pages/SandboxPage"));
const McpPage = lazy(() => import("./pages/McpPage"));
const BrowserPage = lazy(() => import("./pages/BrowserPage"));
const IdentityPage = lazy(() => import("./pages/IdentityPage"));
const EcosystemPage = lazy(() => import("./pages/EcosystemPage"));
const DokobotPage = lazy(() => import("./pages/DokobotPage"));
const ProposalsPage = lazy(() => import("./pages/ProposalsPage"));
const A2aPage = lazy(() => import("./pages/A2aPage"));
const CliPage = lazy(() => import("./pages/CliPage"));
const SkillhubPage = lazy(() => import("./pages/SkillhubPage"));
const RAGPage = lazy(() => import("./pages/RAGPage"));
const ConfigPage = lazy(() => import("./pages/ConfigPage"));
const UploadsPage = lazy(() => import("./pages/UploadsPage"));
const HooksPage = lazy(() => import("./pages/HooksPage"));
const MetricsPage = lazy(() => import("./pages/MetricsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

/** Global app initializer — runs once on mount, parallelizes all store hydration */
function AppInitializer() {
  const { fetchHealth, fetchModelHealth } = useSystemStore();
  const { fetchAgents } = useAgentStore();
  const { fetchTools } = useToolStore();
  const { fetchChannels } = useChannelStore();
  const { init: initChat } = useChatStore();

  useEffect(() => {
    // Parallel initialization with individual error isolation
    Promise.allSettled([fetchHealth(), fetchModelHealth(), fetchAgents(), fetchTools(), fetchChannels(), initChat()]);
  }, []);

  return null;
}

/**
 * Two-mode router (Round I1, 2026-05-20):
 *   `/`            — UserHomePage. Notion-style chat + RAG sidebar.
 *                    NO AppLayout (no admin sidebar). Gear icon in the
 *                    UserHomePage top-right routes to `/dashboard` for
 *                    admin mode.
 *   everything else — AppLayout-wrapped admin pages. Sidebar nav,
 *                     existing dense UI. `/dashboard` is the admin
 *                     landing (formerly at `/`).
 *
 * We render UserHomePage as a separate branch instead of inside
 * AppLayout so it can claim the full viewport without inheriting
 * the admin chrome.
 */
function AdminShell() {
  return (
    <AppLayout>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/plugins" element={<PluginsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/wiki" element={<WikiPage />} />
          <Route path="/kg" element={<KnowledgeGraphPage />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/cron" element={<CronPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/sandbox" element={<SandboxPage />} />
          <Route path="/mcp" element={<McpPage />} />
          <Route path="/browser" element={<BrowserPage />} />
          <Route path="/identity" element={<IdentityPage />} />
          <Route path="/ecosystem" element={<EcosystemPage />} />
          <Route path="/dokobot" element={<DokobotPage />} />
          <Route path="/proposals" element={<ProposalsPage />} />
          <Route path="/a2a" element={<A2aPage />} />
          <Route path="/cli" element={<CliPage />} />
          <Route path="/skillhub" element={<SkillhubPage />} />
          <Route path="/rag" element={<RAGPage />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/uploads" element={<UploadsPage />} />
          <Route path="/hooks" element={<HooksPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Suspense>
    </AppLayout>
  );
}

export default function App() {
  const location = useLocation();
  const isUserMode = location.pathname === "/";

  return (
    <ErrorBoundary>
      <GlobalProgressBar />
      <AppInitializer />
      {isUserMode ? (
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<UserHomePage />} />
          </Routes>
        </Suspense>
      ) : (
        <AdminShell />
      )}
    </ErrorBoundary>
  );
}
