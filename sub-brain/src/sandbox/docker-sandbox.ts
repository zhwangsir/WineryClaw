/**
 * Docker Sandbox — 隔离执行环境
 * Docker sandbox for secure code execution
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SandboxConfig {
  image: string;
  memory: string;
  cpus: number;
  timeout: number;
  network: boolean;
  volumes: string[];
}

const DEFAULT_CONFIG: SandboxConfig = {
  image: "node:20-alpine",
  memory: "512m",
  cpus: 1.0,
  timeout: 30000,
  network: false,
  volumes: [],
};

export class DockerSandbox {
  private config: SandboxConfig;
  private containers = new Set<string>();

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  isAvailable(): boolean {
    try {
      execSync("docker version", { stdio: "pipe", timeout: 5000 });
      return true;
    } catch (err) { console.error("[docker-sandbox] Error:", err);
      return false;
    }
  }

  async execute(command: string, inputFiles?: Record<string, string>): Promise<{ ok: boolean; output: string; exitCode: number; error?: string }> {
    if (!this.isAvailable()) {
      return { ok: false, output: "", exitCode: -1, error: "Docker not available" };
    }

    const containerName = `webrain-sandbox-${Date.now()}`;
    this.containers.add(containerName);

    const tmpDir = join(homedir(), ".webrain", "sandbox", containerName);
    mkdirSync(tmpDir, { recursive: true });

    if (inputFiles) {
      for (const [name, content] of Object.entries(inputFiles)) {
        writeFileSync(join(tmpDir, name), content);
      }
    }

    const volumeMounts = ["-v", `${tmpDir}:/workspace`];
    for (const vol of this.config.volumes) {
      volumeMounts.push("-v", vol);
    }

    const networkFlag = this.config.network ? "" : "--network none";
    const memoryFlag = `--memory=${this.config.memory}`;
    const cpusFlag = `--cpus=${this.config.cpus}`;

    const dockerCmd = [
      "docker", "run", "--rm",
      "--name", containerName,
      memoryFlag, cpusFlag,
      networkFlag,
      ...volumeMounts,
      "-w", "/workspace",
      this.config.image,
      "sh", "-c", command,
    ].filter(Boolean);

    try {
      const output = execSync(dockerCmd.join(" "), {
        encoding: "utf-8",
        timeout: this.config.timeout,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.containers.delete(containerName);
      return { ok: true, output, exitCode: 0 };
    } catch (err: any) {
      this.containers.delete(containerName);
      return {
        ok: false,
        output: err.stdout || "",
        exitCode: err.status || 1,
        error: err.message,
      };
    }
  }

  async executePython(code: string): Promise<{ ok: boolean; output: string; exitCode: number; error?: string }> {
    return this.execute(`python3 -c "${code.replace(/"/g, '\\"')}"`);
  }

  async executeNode(script: string): Promise<{ ok: boolean; output: string; exitCode: number; error?: string }> {
    return this.execute(`node -e "${script.replace(/"/g, '\\"')}"`);
  }

  async cleanup(): Promise<void> {
    for (const name of this.containers) {
      try {
        execSync(`docker rm -f ${name}`, { stdio: "pipe", timeout: 10000 });
      } catch (err) { console.error("[docker-sandbox] Error:", err); console.error("[docker] Error:", err); }
    }
    this.containers.clear();
  }
}
