/**
 * Channel Manager — SQLite 持久化 + 真实协议接口
 * 支持 Telegram, Discord, Slack 等渠道的标准协议抽象
 */

import { subBrainDB } from "../db/sub-brain-db.js";
import WebSocket from "ws";
import { IMessageProtocol, startIMessagePolling } from "./imessage-protocol.js";
import { EmailProtocol, startEmailPolling } from "./email-protocol.js";
import { WebPushProtocol } from "./webpush-protocol.js";

export interface ChannelConfig {
  botToken?: string;
  webhookUrl?: string;
  apiKey?: string;
  channelId?: string;
  [key: string]: unknown;
}

export interface Channel {
  id: string;
  type: string;
  name: string;
  connected: boolean;
  /** M5: when true, inbound messages on this channel are auto-routed
   * to chat_engine and the reply is sent back to the sender. */
  autoReply: boolean;
  config: ChannelConfig;
  protocol: ChannelProtocol;
}

export interface ChannelProtocol {
  sendMessage: (recipient: string, content: string, config: ChannelConfig) => Promise<any>;
  connect: (config: ChannelConfig) => Promise<{ ok: boolean; error?: string }>;
  disconnect: () => Promise<void>;
  health: () => Promise<boolean>;
}

export interface InboundMessage {
  sender: string;
  content: string;
  timestamp: string;
  /** M5: channel-specific identifier needed to reply back. For Telegram
   * this is the chat_id; for Discord, the channel_id; for Slack, the
   * conversation id. Falls back to `sender` for protocols where the
   * sender handle is also the reply target (iMessage, Email). */
  reply_to?: string;
}

/** Callback fired by the manager when a message is stored with
 * direction="inbound". Used by ChannelAutoReply (M5) to route the
 * message into chat_engine and send the response back through the
 * same channel. Sync or async — return value is ignored. */
export type InboundMessageHandler = (
  channelId: string,
  channelType: string,
  message: InboundMessage,
) => void | Promise<void>;

// Telegram Bot API protocol
const TelegramProtocol: ChannelProtocol = {
  async sendMessage(recipient, content, config) {
    const axios = (await import("axios")).default;
    const resp = await axios.post(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      { chat_id: recipient, text: content },
      { timeout: 30000 }
    );
    return resp.data;
  },
  async connect(config) {
    if (!config.botToken) return { ok: false, error: "缺少 botToken" };
    const axios = (await import("axios")).default;
    const resp = await axios.get(`https://api.telegram.org/bot${config.botToken}/getMe`, { timeout: 10000 });
    return { ok: resp.data?.ok === true, error: resp.data?.description };
  },
  async disconnect() {},
  async health() {
    try {
      const axios = (await import("axios")).default;
      // Just check if we can reach Telegram API
      await axios.get("https://api.telegram.org", { timeout: 5000 });
      return true;
    } catch (err) { console.error("[channel-manager] Error:", err); return false; }
  },
};

// Discord Bot API protocol
const DiscordProtocol: ChannelProtocol = {
  async sendMessage(recipient, content, config) {
    const axios = (await import("axios")).default;
    const resp = await axios.post(
      `https://discord.com/api/v10/channels/${recipient}/messages`,
      { content },
      { headers: { Authorization: `Bot ${config.botToken}` }, timeout: 30000 }
    );
    return resp.data;
  },
  async connect(config) {
    if (!config.botToken) return { ok: false, error: "缺少 botToken" };
    const axios = (await import("axios")).default;
    const resp = await axios.get("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${config.botToken}` },
      timeout: 10000,
    });
    return { ok: resp.status === 200, error: resp.data?.message };
  },
  async disconnect() {},
  async health() {
    try {
      const axios = (await import("axios")).default;
      await axios.get("https://discord.com/api/v10/gateway", { timeout: 5000 });
      return true;
    } catch (err) { console.error("[channel-manager] Error:", err); return false; }
  },
};

// Slack Bot API protocol
const SlackProtocol: ChannelProtocol = {
  async sendMessage(recipient, content, config) {
    const axios = (await import("axios")).default;
    const resp = await axios.post(
      "https://slack.com/api/chat.postMessage",
      { channel: recipient, text: content },
      { headers: { Authorization: `Bearer ${config.botToken}` }, timeout: 30000 }
    );
    return resp.data;
  },
  async connect(config) {
    if (!config.botToken) return { ok: false, error: "缺少 botToken" };
    const axios = (await import("axios")).default;
    const resp = await axios.get("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${config.botToken}` },
      timeout: 10000,
    });
    return { ok: resp.data?.ok === true, error: resp.data?.error };
  },
  async disconnect() {},
  async health() {
    try {
      const axios = (await import("axios")).default;
      await axios.get("https://slack.com/api/api.test", { timeout: 5000 });
      return true;
    } catch (err) { console.error("[channel-manager] Error:", err); return false; }
  },
};

// WhatsApp Web.js protocol
const WhatsAppProtocol: ChannelProtocol = {
  async sendMessage(recipient, content, config) {
    // Simple HTTP-based WhatsApp Business API fallback
    // For WhatsApp Web.js, a full implementation would require
    // maintaining a WhatsApp client instance with QR code auth
    const axios = (await import("axios")).default;
    if (config.apiUrl) {
      const resp = await axios.post(
        config.apiUrl as string,
        { to: recipient, body: content },
        { headers: { Authorization: `Bearer ${config.apiKey}` }, timeout: 30000 }
      );
      return resp.data;
    }
    throw new Error("WhatsApp requires apiUrl (WhatsApp Business API endpoint) or use WhatsApp Web.js directly");
  },
  async connect(config) {
    if (!config.apiUrl && !config.sessionData) {
      return { ok: false, error: "缺少 apiUrl 或 sessionData。建议使用 WhatsApp Business API。" };
    }
    return { ok: true };
  },
  async disconnect() {},
  async health() {
    try {
      const axios = (await import("axios")).default;
      await axios.get("https://web.whatsapp.com", { timeout: 5000 });
      return true;
    } catch (err) { console.error("[channel-manager] Error:", err); return false; }
  },
};

// Microsoft Teams Incoming Webhook protocol
const TeamsProtocol: ChannelProtocol = {
  async sendMessage(recipient, content, config) {
    const axios = (await import("axios")).default;
    const webhookUrl = config.webhookUrl as string;
    if (!webhookUrl) throw new Error("Missing webhookUrl");
    const resp = await axios.post(
      webhookUrl,
      {
        text: content,
        sections: [{ activityTitle: "WeBrain", activitySubtitle: content }],
      },
      { timeout: 30000 }
    );
    return resp.data;
  },
  async connect(config) {
    if (!config.webhookUrl) return { ok: false, error: "缺少 webhookUrl。请在 Teams 频道中添加传入 Webhook 连接器。" };
    return { ok: true };
  },
  async disconnect() {},
  async health() {
    try {
      const axios = (await import("axios")).default;
      await axios.get("https://teams.microsoft.com", { timeout: 5000 });
      return true;
    } catch (err) { console.error("[channel-manager] Error:", err); return false; }
  },
};

// Feishu / Lark Webhook protocol
const FeishuProtocol: ChannelProtocol = {
  async sendMessage(recipient, content, config) {
    const axios = (await import("axios")).default;
    const webhookUrl = config.webhookUrl as string;
    if (!webhookUrl) throw new Error("Missing webhookUrl");
    const resp = await axios.post(
      webhookUrl,
      { msg_type: "text", content: { text: content } },
      { timeout: 30000 }
    );
    return resp.data;
  },
  async connect(config) {
    if (!config.webhookUrl) return { ok: false, error: "缺少 webhookUrl。请在飞书群中添加自定义机器人。" };
    return { ok: true };
  },
  async disconnect() {},
  async health() {
    try {
      const axios = (await import("axios")).default;
      await axios.get("https://open.feishu.cn", { timeout: 5000 });
      return true;
    } catch (err) { console.error("[channel-manager] Error:", err); return false; }
  },
};

// LINE Messaging API protocol
const LineProtocol: ChannelProtocol = {
  async sendMessage(recipient, content, config) {
    const axios = (await import("axios")).default;
    const resp = await axios.post(
      "https://api.line.me/v2/bot/message/push",
      { to: recipient, messages: [{ type: "text", text: content }] },
      { headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, timeout: 30000 }
    );
    return resp.data;
  },
  async connect(config) {
    if (!config.apiKey) return { ok: false, error: "缺少 Channel Access Token" };
    const axios = (await import("axios")).default;
    const resp = await axios.get("https://api.line.me/v2/bot/info", {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      timeout: 10000,
    });
    return { ok: resp.status === 200 };
  },
  async disconnect() {},
  async health() {
    try {
      const axios = (await import("axios")).default;
      await axios.get("https://api.line.me", { timeout: 5000 });
      return true;
    } catch (err) { console.error("[channel-manager] Error:", err); return false; }
  },
};

const PROTOCOL_REGISTRY: Record<string, ChannelProtocol> = {
  telegram: TelegramProtocol,
  discord: DiscordProtocol,
  slack: SlackProtocol,
  whatsapp: WhatsAppProtocol,
  teams: TeamsProtocol,
  feishu: FeishuProtocol,
  line: LineProtocol,
  imessage: IMessageProtocol,
  email: EmailProtocol,
  webpush: WebPushProtocol,
};

export class ChannelManager {
  private channels = new Map<string, Channel>();
  private db = subBrainDB.getDb();
  private broadcast: ((msg: any) => void) | null = null;
  private inboundHandler: InboundMessageHandler | null = null;
  private receivers = new Map<string, { stop: () => void }>();

  setBroadcastHandler(handler: (msg: any) => void): void {
    this.broadcast = handler;
  }

  /** M5: register a handler invoked for every inbound message. */
  setInboundHandler(handler: InboundMessageHandler | null): void {
    this.inboundHandler = handler;
  }

  async initialize(): Promise<void> {
    // Load persisted channels from SQLite
    const rows = this.db.prepare("SELECT * FROM channels").all() as any[];
    for (const row of rows) {
      const config = JSON.parse(row.config || "{}");
      const protocol = PROTOCOL_REGISTRY[row.type];
      if (protocol) {
        this.channels.set(row.id, {
          id: row.id,
          type: row.type,
          name: row.name,
          connected: !!row.connected,
          autoReply: !!row.auto_reply,
          config,
          protocol,
        });
      }
    }
    console.log(`[channels] Loaded ${this.channels.size} persisted channels`);
  }

  async connect(channelType: string, config: ChannelConfig): Promise<{ ok: boolean; channel_id?: string; error?: string }> {
    const protocol = PROTOCOL_REGISTRY[channelType];
    if (!protocol) {
      return { ok: false, error: `不支持的渠道类型: ${channelType}` };
    }

    // Test connection
    const test = await protocol.connect(config);
    if (!test.ok) {
      return { ok: false, error: test.error || "连接测试失败" };
    }

    const id = `${channelType}-${Date.now()}`;
    const channel: Channel = {
      id,
      type: channelType,
      name: (config.channelId as string) || channelType,
      connected: true,
      autoReply: false,
      config,
      protocol,
    };

    this.channels.set(id, channel);

    // Persist to SQLite
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO channels (id, type, name, connected, config, auto_reply, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    stmt.run(
      id,
      channelType,
      channel.name,
      1,
      JSON.stringify(config),
      0,
      new Date().toISOString(),
      new Date().toISOString(),
    );

    return { ok: true, channel_id: id };
  }

  /** M5: toggle auto-reply state for a channel. Persists to SQLite. */
  async setAutoReply(channelId: string, enabled: boolean): Promise<{ ok: boolean; auto_reply?: boolean; error?: string }> {
    const channel = this.channels.get(channelId);
    if (!channel) return { ok: false, error: "Channel not found" };
    channel.autoReply = enabled;
    const stmt = this.db.prepare("UPDATE channels SET auto_reply = ?, updated_at = ? WHERE id = ?");
    stmt.run(enabled ? 1 : 0, new Date().toISOString(), channelId);
    return { ok: true, auto_reply: enabled };
  }

  /** M5: query auto-reply state. */
  getAutoReply(channelId: string): boolean {
    const channel = this.channels.get(channelId);
    return channel ? channel.autoReply : false;
  }

  async send(channelIdOrType: string, recipient: string, content: string): Promise<{ ok: boolean; error?: string; result?: any }> {
    let channel = this.channels.get(channelIdOrType);
    if (!channel) {
      for (const ch of this.channels.values()) {
        if (ch.type === channelIdOrType) {
          channel = ch;
          break;
        }
      }
    }

    if (!channel) {
      return { ok: false, error: `Channel not found: ${channelIdOrType}` };
    }
    if (!channel.connected) {
      return { ok: false, error: `Channel disconnected: ${channelIdOrType}` };
    }

    try {
      const result = await channel.protocol.sendMessage(recipient, content, channel.config);
      // Store outbound message
      this.storeMessage(channel.id, { sender: "webrain", content, timestamp: new Date().toISOString() }, "outbound");
      return { ok: true, result };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.description || err.message };
    }
  }

  async disconnect(channelId: string): Promise<{ ok: boolean; error?: string }> {
    const channel = this.channels.get(channelId);
    if (!channel) return { ok: false, error: "Channel not found" };

    // Stop receiving if active
    if (this.receivers.has(channelId)) {
      try { await this.stopReceiving(channelId); } catch (err) { console.error("[channel-manager] Error:", err); /* ignore */ }
    }

    await channel.protocol.disconnect();
    channel.connected = false;

    const stmt = this.db.prepare("UPDATE channels SET connected = 0, updated_at = ? WHERE id = ?");
    stmt.run(new Date().toISOString(), channelId);

    return { ok: true };
  }

  async toggle(channelId: string): Promise<{ ok: boolean; connected?: boolean; error?: string }> {
    const channel = this.channels.get(channelId);
    if (!channel) return { ok: false, error: "Channel not found" };

    if (channel.connected) {
      const result = await this.disconnect(channelId);
      return { ...result, connected: false };
    } else {
      // Reconnect using stored config
      const test = await channel.protocol.connect(channel.config);
      if (!test.ok) {
        return { ok: false, error: test.error || "Reconnect failed" };
      }
      channel.connected = true;
      const stmt = this.db.prepare("UPDATE channels SET connected = 1, updated_at = ? WHERE id = ?");
      stmt.run(new Date().toISOString(), channelId);
      return { ok: true, connected: true };
    }
  }

  async deleteChannel(channelId: string): Promise<{ ok: boolean; error?: string }> {
    const channel = this.channels.get(channelId);
    if (!channel) return { ok: false, error: "Channel not found" };

    // Stop receiving if active
    if (this.receivers.has(channelId)) {
      try { await this.stopReceiving(channelId); } catch (err) { console.error("[channel-manager] Error:", err); /* ignore */ }
    }

    // Disconnect if connected
    if (channel.connected) {
      try { await channel.protocol.disconnect(); } catch (err) { console.error("[channel-manager] Error:", err); /* ignore */ }
    }

    this.channels.delete(channelId);
    const stmt = this.db.prepare("DELETE FROM channels WHERE id = ?");
    stmt.run(channelId);
    return { ok: true };
  }

  listChannels(): Array<{ id: string; name: string; type: string; connected: boolean; auto_reply: boolean }> {
    return Array.from(this.channels.values()).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      connected: c.connected,
      auto_reply: c.autoReply,
    }));
  }

  async healthCheck(channelId: string): Promise<boolean> {
    const channel = this.channels.get(channelId);
    if (!channel) return false;
    return channel.protocol.health();
  }

  // ========== Receiving ==========

  private storeMessage(channelId: string, msg: InboundMessage, direction: "inbound" | "outbound" = "inbound"): void {
    const stmt = this.db.prepare(
      "INSERT INTO messages (channel_id, sender, content, timestamp, direction, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    stmt.run(channelId, msg.sender, msg.content, msg.timestamp, direction, new Date().toISOString());
    if (this.broadcast) {
      this.broadcast({ type: "channel.message", channelId, message: { ...msg, direction } });
    }
    // M5: dispatch inbound messages to the registered handler (auto-reply
    // engine). Fire-and-forget — handler errors must not break inbound
    // message persistence. We swallow rejections after logging.
    if (direction === "inbound" && this.inboundHandler) {
      const channel = this.channels.get(channelId);
      if (channel) {
        try {
          const result = this.inboundHandler(channelId, channel.type, msg);
          if (result && typeof (result as Promise<void>).then === "function") {
            (result as Promise<void>).catch((err) =>
              console.error(`[channel-manager] inbound handler failed for ${channelId}:`, err),
            );
          }
        } catch (err) {
          console.error(`[channel-manager] inbound handler threw for ${channelId}:`, err);
        }
      }
    }
  }

  getMessages(channelId: string, limit = 50): any[] {
    const stmt = this.db.prepare(
      "SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?"
    );
    return stmt.all(channelId, limit) as any[];
  }

  async startReceiving(channelId: string): Promise<{ ok: boolean; error?: string }> {
    const channel = this.channels.get(channelId);
    if (!channel) return { ok: false, error: "Channel not found" };
    if (this.receivers.has(channelId)) return { ok: false, error: "Already receiving" };
    if (!channel.connected) return { ok: false, error: "Channel not connected" };

    switch (channel.type) {
      case "telegram":
        return this.startTelegramPolling(channel);
      case "discord":
        return this.startDiscordGateway(channel);
      case "slack":
        return this.startSlackPolling(channel);
      case "imessage":
        return this.startIMessagePolling(channel);
      case "email":
        return this.startEmailPolling(channel);
      default:
        return { ok: false, error: "Unsupported channel type for receiving" };
    }
  }

  async stopReceiving(channelId: string): Promise<{ ok: boolean; error?: string }> {
    const receiver = this.receivers.get(channelId);
    if (!receiver) return { ok: false, error: "Not receiving" };
    receiver.stop();
    this.receivers.delete(channelId);
    return { ok: true };
  }

  isReceiving(channelId: string): boolean {
    return this.receivers.has(channelId);
  }

  // Telegram long-polling via getUpdates
  private startTelegramPolling(channel: Channel): { ok: boolean; error?: string } {
    let offset = 0;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const axios = (await import("axios")).default;
        const resp = await axios.get(
          `https://api.telegram.org/bot${channel.config.botToken}/getUpdates`,
          { params: { offset, limit: 100 }, timeout: 10000 }
        );
        if (resp.data?.ok && resp.data.result?.length) {
          for (const update of resp.data.result) {
            if (update.message) {
              const from = update.message.from || {};
              const sender = [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || from.username || "unknown";
              // chat.id is the reply target. For private chats it equals the
              // user id; for groups it's the group id. Either way, this is
              // what `sendMessage` needs.
              const replyTo = update.message.chat?.id != null ? String(update.message.chat.id) : sender;
              this.storeMessage(channel.id, {
                sender,
                content: update.message.text || "",
                timestamp: new Date(update.message.date * 1000).toISOString(),
                reply_to: replyTo,
              });
            }
            offset = update.update_id + 1;
          }
        }
      } catch (err) { console.error("[channel-manager] Error:", err);
        console.error(`[telegram-poll] error for ${channel.id}:`, err);
      }
    };

    // Initial tick then every 2 seconds
    tick();
    const interval = setInterval(tick, 2000);

    this.receivers.set(channel.id, {
      stop: () => {
        stopped = true;
        clearInterval(interval);
      },
    });

    return { ok: true };
  }

  // Discord Gateway WebSocket
  private async startDiscordGateway(channel: Channel): Promise<{ ok: boolean; error?: string }> {
    try {
      const axios = (await import("axios")).default;
      const gatewayResp = await axios.get("https://discord.com/api/v10/gateway/bot", {
        headers: { Authorization: `Bot ${channel.config.botToken}` },
        timeout: 10000,
      });

      const wsUrl = `${gatewayResp.data.url}?v=10&encoding=json`;
      const ws = new WebSocket(wsUrl);
      let heartbeatTimer: any;
      let seq: number | null = null;
      let identified = false;

      ws.on("open", () => {
        console.log(`[discord-gw] connected for ${channel.id}`);
      });

      ws.on("message", (raw: any) => {
        try {
          const payload = JSON.parse(raw.toString());
          if (payload.s !== null) seq = payload.s;

          switch (payload.op) {
            case 10: { // Hello
              const interval = payload.d.heartbeat_interval;
              heartbeatTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: seq }));
                }
              }, interval);
              // Send IDENTIFY
              ws.send(JSON.stringify({
                op: 2,
                d: {
                  token: channel.config.botToken,
                  intents: 512, // GUILD_MESSAGES
                  properties: { os: "linux", browser: "webrain", device: "webrain" },
                },
              }));
              identified = true;
              break;
            }
            case 0: { // Dispatch
              if (payload.t === "MESSAGE_CREATE" && payload.d) {
                const author = payload.d.author || {};
                this.storeMessage(channel.id, {
                  sender: author.username || author.global_name || "unknown",
                  content: payload.d.content || "",
                  timestamp: new Date(payload.d.timestamp || Date.now()).toISOString(),
                  // Discord's reply target is the channel the message arrived in.
                  reply_to: payload.d.channel_id || undefined,
                });
              }
              break;
            }
            case 11: // Heartbeat ACK
              break;
            case 1: { // Heartbeat request
              ws.send(JSON.stringify({ op: 1, d: seq }));
              break;
            }
            case 7: // Reconnect
              ws.close();
              break;
            case 9: // Invalid session
              identified = false;
              ws.close();
              break;
          }
        } catch (err) { console.error("[channel-manager] Error:", err);
          console.error(`[discord-gw] message parse error for ${channel.id}:`, err);
        }
      });

      ws.on("error", (err) => {
        console.error(`[discord-gw] error for ${channel.id}:`, err.message);
      });

      ws.on("close", () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        this.receivers.delete(channel.id);
        console.log(`[discord-gw] closed for ${channel.id}`);
      });

      this.receivers.set(channel.id, {
        stop: () => {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          try { ws.terminate(); } catch (err) { console.error("[channel-manager] Error:", err); /* ignore */ }
          this.receivers.delete(channel.id);
        },
      });

      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // Slack Events API polling via conversations.history
  private startSlackPolling(channel: Channel): { ok: boolean; error?: string } {
    let stopped = false;
    const seenMessages = new Set<string>();
    const lastTsMap = new Map<string, string>();

    const tick = async () => {
      if (stopped) return;
      try {
        const axios = (await import("axios")).default;
        const token = channel.config.botToken;
        if (!token) return;

        // List conversations
        const convResp = await axios.get("https://slack.com/api/conversations.list", {
          headers: { Authorization: `Bearer ${token}` },
          params: { types: "public_channel,private_channel,im", limit: 20 },
          timeout: 10000,
        });
        if (!convResp.data?.ok) return;

        const conversations = convResp.data.channels || [];
        for (const conv of conversations) {
          const params: any = { channel: conv.id, limit: 10 };
          const lastTs = lastTsMap.get(conv.id);
          if (lastTs) params.oldest = lastTs;

          const histResp = await axios.get("https://slack.com/api/conversations.history", {
            headers: { Authorization: `Bearer ${token}` },
            params,
            timeout: 10000,
          });
          if (!histResp.data?.ok) continue;

          const messages = histResp.data.messages || [];
          for (const msg of messages) {
            const msgId = `${conv.id}-${msg.ts}`;
            if (seenMessages.has(msgId)) continue;
            seenMessages.add(msgId);

            // Update latest timestamp for this conversation
            if (!lastTsMap.has(conv.id) || parseFloat(msg.ts) > parseFloat(lastTsMap.get(conv.id)!)) {
              lastTsMap.set(conv.id, msg.ts);
            }

            // Only process inbound messages (not from bots)
            if (msg.bot_id) continue;
            if (!msg.user) continue;

            this.storeMessage(channel.id, {
              sender: msg.user,
              content: msg.text || "",
              timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
              // Slack replies go to the conversation id, not the user.
              reply_to: conv.id,
            });
          }
        }

        // Prune seen set if too large
        if (seenMessages.size > 10000) {
          const arr = Array.from(seenMessages).slice(-5000);
          seenMessages.clear();
          arr.forEach((id) => seenMessages.add(id));
        }
      } catch (err) { console.error("[channel-manager] Error:", err);
        console.error(`[slack-poll] error for ${channel.id}:`, err);
      }
    };

    tick();
    const interval = setInterval(tick, 3000);

    this.receivers.set(channel.id, {
      stop: () => {
        stopped = true;
        clearInterval(interval);
      },
    });

    return { ok: true };
  }

  // iMessage polling via chat.db
  private startIMessagePolling(channel: Channel): { ok: boolean; error?: string } {
    const handle = channel.config.handle as string || channel.config.recipient as string || "";
    if (!handle) return { ok: false, error: "Missing handle/recipient config" };

    const { startIMessagePolling: startPoll } = require("./imessage-protocol.js");
    const receiver = startPoll(
      channel.id,
      handle,
      (msg: any) => this.storeMessage(channel.id, msg),
    );
    this.receivers.set(channel.id, receiver);
    return { ok: true };
  }

  // Email IMAP polling
  private async startEmailPolling(channel: Channel): Promise<{ ok: boolean; error?: string }> {
    const { startEmailPolling: startPoll } = await import("./email-protocol.js");
    const receiver = await startPoll(
      channel.id,
      channel.config as any,
      (msg) => this.storeMessage(channel.id, msg),
    );
    this.receivers.set(channel.id, receiver);
    return { ok: true };
  }
}
