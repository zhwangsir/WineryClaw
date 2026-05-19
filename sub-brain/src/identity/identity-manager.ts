/**
 * Identity Manager — 身份认证、用户权限、Workspace 隔离
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash, randomBytes } from "crypto";

export interface User {
  id: string;
  name: string;
  email?: string;
  role: "admin" | "user" | "guest";
  workspaces: string[];
  apiKey: string;
  createdAt: string;
}

export interface AuthResult {
  authenticated: boolean;
  user?: User;
  error?: string;
}

const IDENTITY_DIR = join(homedir(), ".webrain", "identity");
const USERS_PATH = join(IDENTITY_DIR, "users.json");

export class IdentityManager {
  private users = new Map<string, User>();

  constructor() {
    this.load();
    if (this.users.size === 0) {
      this.createDefaultUser();
    }
  }

  private load(): void {
    try {
      if (existsSync(USERS_PATH)) {
        const raw = readFileSync(USERS_PATH, "utf-8");
        const list: User[] = JSON.parse(raw);
        for (const u of list) this.users.set(u.id, u);
      }
    } catch (err) { console.error("[identity-manager] Error:", err);
      console.error("[identity] Load failed:", err);
    }
  }

  private save(): void {
    if (!existsSync(IDENTITY_DIR)) mkdirSync(IDENTITY_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(USERS_PATH, JSON.stringify(Array.from(this.users.values()), null, 2), { mode: 0o600 });
  }

  private createDefaultUser(): void {
    const user: User = {
      id: "user-default",
      name: "Default User",
      role: "admin",
      workspaces: ["default"],
      apiKey: `wb-${randomBytes(16).toString("hex")}`,
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    this.save();
    console.log("[identity] Default user created:", user.id);
  }

  authenticate(apiKey: string): AuthResult {
    for (const user of this.users.values()) {
      if (user.apiKey === apiKey) {
        return { authenticated: true, user };
      }
    }
    return { authenticated: false, error: "Invalid API key" };
  }

  createUser(name: string, role: "admin" | "user" | "guest" = "user", workspaces: string[] = ["default"]): User {
    const user: User = {
      id: `user-${Date.now()}`,
      name,
      role,
      workspaces,
      apiKey: `wb-${randomBytes(16).toString("hex")}`,
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    this.save();
    return user;
  }

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  listUsers(): User[] {
    return Array.from(this.users.values());
  }

  deleteUser(id: string): boolean {
    if (!this.users.has(id)) return false;
    this.users.delete(id);
    this.save();
    return true;
  }

  hasWorkspaceAccess(userId: string, workspaceId: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;
    if (user.role === "admin") return true;
    return user.workspaces.includes(workspaceId);
  }
}
