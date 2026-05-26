import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSkillhubStore } from "./skillhubStore";

vi.mock("../api/skillhub", () => ({
  skillhubApi: {
    list: vi.fn(),
    search: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    listInstalled: vi.fn(),
    listRegistries: vi.fn(),
    addRegistry: vi.fn(),
    removeRegistry: vi.fn(),
    updateRegistry: vi.fn(), // v2.39
    refresh: vi.fn(),
    listCandidates: vi.fn(),
    improve: vi.fn(),
    listDrafts: vi.fn(),
    promoteDraft: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import { skillhubApi } from "../api/skillhub";
import { message } from "antd";

function resetState() {
  useSkillhubStore.setState({
    skills: [],
    loading: false,
    installed: [],
    installedLoading: false,
    registries: [],
    registriesLoading: false,
    candidates: [],
    candidatesLoading: false,
    drafts: [],
    draftsLoading: false,
  });
}

describe("skillhubStore", () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  // ---- initial state ----

  it("has correct initial state", () => {
    const s = useSkillhubStore.getState();
    expect(s.skills).toEqual([]);
    expect(s.installed).toEqual([]);
    expect(s.registries).toEqual([]);
    expect(s.candidates).toEqual([]);
    expect(s.drafts).toEqual([]);
    expect(s.loading).toBe(false);
  });

  // ---- marketplace: fetch / search ----

  it("fetchSkills loads + clears loading", async () => {
    const data = [{ name: "X", slug: "x", version: "1" }];
    vi.mocked(skillhubApi.list).mockResolvedValue(data);
    await useSkillhubStore.getState().fetchSkills();
    expect(useSkillhubStore.getState().skills).toEqual(data);
    expect(useSkillhubStore.getState().loading).toBe(false);
  });

  it("fetchSkills handles errors with custom message", async () => {
    vi.mocked(skillhubApi.list).mockRejectedValue(new Error(""));
    await useSkillhubStore.getState().fetchSkills();
    expect(message.error).toHaveBeenCalledWith("获取技能列表失败");
    expect(useSkillhubStore.getState().loading).toBe(false);
  });

  it("search delegates to skillhubApi.search(q)", async () => {
    vi.mocked(skillhubApi.search).mockResolvedValue([]);
    await useSkillhubStore.getState().search("foo");
    expect(skillhubApi.search).toHaveBeenCalledWith("foo");
  });

  // ---- install / uninstall (new InstallResult contract) ----

  it("install on ok=true triggers success + refresh", async () => {
    vi.mocked(skillhubApi.install).mockResolvedValue({ ok: true, skillId: "x" });
    vi.mocked(skillhubApi.list).mockResolvedValue([]);
    vi.mocked(skillhubApi.listInstalled).mockResolvedValue([]);
    await useSkillhubStore.getState().install("x");
    expect(message.success).toHaveBeenCalledWith('技能 "x" 安装成功');
    expect(skillhubApi.list).toHaveBeenCalled();
    expect(skillhubApi.listInstalled).toHaveBeenCalled();
  });

  it("install on ok=false shows error from backend", async () => {
    vi.mocked(skillhubApi.install).mockResolvedValue({ ok: false, error: "not in registry" });
    await useSkillhubStore.getState().install("x");
    expect(message.error).toHaveBeenCalledWith("not in registry");
  });

  it("install on throw shows fallback error", async () => {
    vi.mocked(skillhubApi.install).mockRejectedValue(new Error(""));
    await useSkillhubStore.getState().install("x");
    expect(message.error).toHaveBeenCalledWith("安装失败");
  });

  it("uninstall on ok=true triggers success + refresh", async () => {
    vi.mocked(skillhubApi.uninstall).mockResolvedValue({ ok: true });
    vi.mocked(skillhubApi.list).mockResolvedValue([]);
    vi.mocked(skillhubApi.listInstalled).mockResolvedValue([]);
    await useSkillhubStore.getState().uninstall("x");
    expect(message.success).toHaveBeenCalledWith('技能 "x" 已卸载');
  });

  it("uninstall on ok=false shows backend error", async () => {
    vi.mocked(skillhubApi.uninstall).mockResolvedValue({ ok: false, error: "not installed" });
    await useSkillhubStore.getState().uninstall("x");
    expect(message.error).toHaveBeenCalledWith("not installed");
  });

  // ---- installed ----

  it("fetchInstalled stores response", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = [{ id: "s1", name: "S1", version: 1 }];
    vi.mocked(skillhubApi.listInstalled).mockResolvedValue(data);
    await useSkillhubStore.getState().fetchInstalled();
    expect(useSkillhubStore.getState().installed).toEqual(data);
  });

  // ---- registries CRUD ----

  it("fetchRegistries loads list", async () => {
    const regs = [{ name: "r1", url: "u", enabled: true }];
    vi.mocked(skillhubApi.listRegistries).mockResolvedValue(regs);
    await useSkillhubStore.getState().fetchRegistries();
    expect(useSkillhubStore.getState().registries).toEqual(regs);
  });

  it("addRegistry returns true on success + triggers refetch", async () => {
    vi.mocked(skillhubApi.addRegistry).mockResolvedValue({ ok: true });
    vi.mocked(skillhubApi.listRegistries).mockResolvedValue([]);
    const ok = await useSkillhubStore.getState().addRegistry({
      name: "r1",
      url: "u",
      enabled: true,
    });
    expect(ok).toBe(true);
    expect(skillhubApi.listRegistries).toHaveBeenCalled();
  });

  it("addRegistry returns false on backend error", async () => {
    vi.mocked(skillhubApi.addRegistry).mockResolvedValue({ ok: false, error: "dup" });
    const ok = await useSkillhubStore.getState().addRegistry({
      name: "r1",
      url: "u",
      enabled: true,
    });
    expect(ok).toBe(false);
    expect(message.error).toHaveBeenCalledWith("dup");
  });

  it("removeRegistry returns true on success", async () => {
    vi.mocked(skillhubApi.removeRegistry).mockResolvedValue({ ok: true });
    vi.mocked(skillhubApi.listRegistries).mockResolvedValue([]);
    const ok = await useSkillhubStore.getState().removeRegistry("r1");
    expect(ok).toBe(true);
  });

  // v2.39 — updateRegistry partial patch (used by UI Switch toggle).

  it("v2.39: updateRegistry flips enabled and refetches", async () => {
    vi.mocked(skillhubApi.updateRegistry).mockResolvedValue({ ok: true });
    vi.mocked(skillhubApi.listRegistries).mockResolvedValue([{ name: "r1", url: "u", enabled: true, priority: 50 }]);
    const ok = await useSkillhubStore.getState().updateRegistry("r1", { enabled: true });
    expect(ok).toBe(true);
    expect(skillhubApi.updateRegistry).toHaveBeenCalledWith("r1", { enabled: true });
    // refetch was triggered after success.
    expect(skillhubApi.listRegistries).toHaveBeenCalled();
    expect(message.success).toHaveBeenCalled();
  });

  it("v2.39: updateRegistry returns false on backend error", async () => {
    vi.mocked(skillhubApi.updateRegistry).mockResolvedValue({
      ok: false,
      error: "not found",
    });
    const ok = await useSkillhubStore.getState().updateRegistry("nope", { enabled: true });
    expect(ok).toBe(false);
    expect(message.error).toHaveBeenCalled();
    // No refetch on failure.
    expect(skillhubApi.listRegistries).not.toHaveBeenCalled();
  });

  it("v2.39: updateRegistry surfaces enable/disable language in success toast", async () => {
    vi.mocked(skillhubApi.updateRegistry).mockResolvedValue({ ok: true });
    vi.mocked(skillhubApi.listRegistries).mockResolvedValue([]);

    await useSkillhubStore.getState().updateRegistry("r1", { enabled: false });
    expect(message.success).toHaveBeenCalledWith(expect.stringMatching(/已停用/));

    vi.clearAllMocks();
    vi.mocked(skillhubApi.updateRegistry).mockResolvedValue({ ok: true });
    vi.mocked(skillhubApi.listRegistries).mockResolvedValue([]);
    await useSkillhubStore.getState().updateRegistry("r1", { enabled: true });
    expect(message.success).toHaveBeenCalledWith(expect.stringMatching(/已启用/));
  });

  it("refresh with errors triggers warning, success otherwise", async () => {
    vi.mocked(skillhubApi.refresh).mockResolvedValue({
      refreshed: ["r1"],
      errors: { r2: "down" },
    });
    vi.mocked(skillhubApi.list).mockResolvedValue([]);
    await useSkillhubStore.getState().refresh();
    expect(message.warning).toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(skillhubApi.refresh).mockResolvedValue({ refreshed: ["r1", "r2"], errors: {} });
    vi.mocked(skillhubApi.list).mockResolvedValue([]);
    await useSkillhubStore.getState().refresh();
    expect(message.success).toHaveBeenCalled();
  });

  // ---- improvements ----

  it("fetchCandidates loads list", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cands: any[] = [
      { skill: { id: "s1", name: "S1" }, primaryFailureMode: { count: 5, signature: "X" }, reason: "r" },
    ];
    vi.mocked(skillhubApi.listCandidates).mockResolvedValue(cands);
    await useSkillhubStore.getState().fetchCandidates();
    expect(useSkillhubStore.getState().candidates).toEqual(cands);
  });

  it("improve returns true on ok=true + refetches candidates", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(skillhubApi.improve).mockResolvedValue({ ok: true, fork: { id: "f1" } as any });
    vi.mocked(skillhubApi.listCandidates).mockResolvedValue([]);
    const ok = await useSkillhubStore.getState().improve("s1", "code", "reason");
    expect(ok).toBe(true);
    expect(skillhubApi.listCandidates).toHaveBeenCalled();
  });

  it("improve returns false + shows error on ok=false", async () => {
    vi.mocked(skillhubApi.improve).mockResolvedValue({ ok: false, error: "missing" });
    const ok = await useSkillhubStore.getState().improve("s1", "code", "reason");
    expect(ok).toBe(false);
    expect(message.error).toHaveBeenCalledWith("missing");
  });

  // ---- drafts ----

  it("fetchDrafts loads list", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drafts: any[] = [{ id: "d1", name: "D1" }];
    vi.mocked(skillhubApi.listDrafts).mockResolvedValue(drafts);
    await useSkillhubStore.getState().fetchDrafts();
    expect(useSkillhubStore.getState().drafts).toEqual(drafts);
  });

  it("promoteDraft returns true + refreshes drafts + installed", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(skillhubApi.promoteDraft).mockResolvedValue({ ok: true, skill: { id: "x" } as any });
    vi.mocked(skillhubApi.listDrafts).mockResolvedValue([]);
    vi.mocked(skillhubApi.listInstalled).mockResolvedValue([]);
    const ok = await useSkillhubStore.getState().promoteDraft("d1");
    expect(ok).toBe(true);
    expect(skillhubApi.listDrafts).toHaveBeenCalled();
    expect(skillhubApi.listInstalled).toHaveBeenCalled();
  });

  it("promoteDraft returns false on ok=false", async () => {
    vi.mocked(skillhubApi.promoteDraft).mockResolvedValue({ ok: false, error: "no draft" });
    const ok = await useSkillhubStore.getState().promoteDraft("d1");
    expect(ok).toBe(false);
  });
});
