/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import UserProfilePanel from "./UserProfilePanel";
import * as userProfileApi from "../../api/userProfile";

describe("UserProfilePanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders empty state when no profile", async () => {
    vi.spyOn(userProfileApi.userProfileApi, "getProfile").mockResolvedValue({ profile: null });
    render(<UserProfilePanel />);
    await waitFor(() => {
      expect(screen.getByText(/暂无画像/)).toBeInTheDocument();
    });
  });

  it("renders profile fields when profile exists", async () => {
    vi.spyOn(userProfileApi.userProfileApi, "getProfile").mockResolvedValue({
      profile: {
        name: "Alice",
        interests: ["AI", "Reading"],
        communication_style: "concise",
        expertise_areas: ["Backend"],
        preferred_tools: ["Python", "FastAPI"],
        timezone: "UTC+8",
        created_at: "2026-05-24T00:00:00+08:00",
        updated_at: "2026-05-24T00:00:00+08:00",
      },
    });
    render(<UserProfilePanel />);
    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("AI")).toBeInTheDocument();
      expect(screen.getByText("Backend")).toBeInTheDocument();
      expect(screen.getByText("Python")).toBeInTheDocument();
      expect(screen.getByText("UTC+8")).toBeInTheDocument();
    });
  });

  it("calls refresh API when clicking refresh button", async () => {
    vi.spyOn(userProfileApi.userProfileApi, "getProfile").mockResolvedValue({ profile: null });
    const refreshSpy = vi.spyOn(userProfileApi.userProfileApi, "refreshProfile").mockResolvedValue({
      profile: {
        name: "Bob",
        interests: [],
        communication_style: "",
        expertise_areas: [],
        preferred_tools: [],
        timezone: null,
        created_at: "",
        updated_at: "",
      },
      message: "Profile updated",
    });
    render(<UserProfilePanel />);
    await waitFor(() => screen.getByText(/暂无画像/));
    fireEvent.click(screen.getByText("立即更新"));
    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
      expect(screen.getByText("Bob")).toBeInTheDocument();
    });
  });

  it("calls delete API when clicking reset button", async () => {
    vi.spyOn(userProfileApi.userProfileApi, "getProfile").mockResolvedValue({
      profile: {
        name: "Charlie",
        interests: [],
        communication_style: "",
        expertise_areas: [],
        preferred_tools: [],
        timezone: null,
        created_at: "",
        updated_at: "",
      },
    });
    const deleteSpy = vi.spyOn(userProfileApi.userProfileApi, "deleteProfile").mockResolvedValue({ removed: ["profile.json"] });
    render(<UserProfilePanel />);
    await waitFor(() => screen.getByText("Charlie"));
    fireEvent.click(screen.getByText("重置画像"));
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalled();
      expect(screen.getByText(/暂无画像/)).toBeInTheDocument();
    });
  });
});
