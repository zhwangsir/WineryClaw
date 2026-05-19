import { describe, it, expect } from "vitest";

vi.mock("i18next", () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn().mockReturnThis(),
  },
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "plugin" },
}));

vi.mock("i18next-browser-languagedetector", () => ({
  default: { type: "detector" },
}));

describe("i18n init", () => {
  it("initializes without error", async () => {
    const i18nModule = await import("./index");
    expect(i18nModule.default).toBeDefined();
  });
});
