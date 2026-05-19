import { describe, it, expect } from "vitest";
import { getAntdTheme, getAntdThemeSync, designTokens } from "./theme";

describe("theme", () => {
  it("getAntdTheme returns light theme config", () => {
    const theme = getAntdTheme(false);
    expect(theme.algorithm).toBeDefined();
    expect(theme.token).toBeDefined();
    expect(theme.components).toBeDefined();
    expect(theme.token?.colorPrimary).toBe("#000000");
    expect(theme.token?.colorBgLayout).toBe("#ffffff");
  });

  it("getAntdTheme returns dark theme config", () => {
    const theme = getAntdTheme(true);
    expect(theme.token?.colorPrimary).toBe("#f5f5f5");
    expect(theme.token?.colorBgLayout).toBe("#0a0a0a");
  });

  it("getAntdThemeSync returns tokens and components without algorithm", () => {
    const sync = getAntdThemeSync(false);
    expect(sync.token).toBeDefined();
    expect(sync.components).toBeDefined();
    expect("algorithm" in sync).toBe(false);
  });

  it("designTokens has spacing scale", () => {
    expect(designTokens.spacing.xs).toBe(4);
    expect(designTokens.spacing["2xl"]).toBe(48);
  });

  it("designTokens has radius scale", () => {
    expect(designTokens.radius.sm).toBe(6);
    expect(designTokens.radius.full).toBe(9999);
  });

  it("designTokens has breakpoints", () => {
    expect(designTokens.breakpoints.md).toBe(768);
    expect(designTokens.breakpoints["4k"]).toBe(3840);
  });
});
