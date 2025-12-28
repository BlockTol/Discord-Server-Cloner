/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Guild, Role } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildRoleStore, GuildStore, Menu, React, RestAPI } from "@webpack/common";

const GuildChannelStore = findStoreLazy("GuildChannelStore");

const PLUGIN_VERSION = "1.0.0";
const GITHUB_REPO = "BlockTol/Discord-Server-Cloner";
const UPDATE_CHECK_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASE_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const UPDATE_CHECK_ENABLED = true;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const randomDelay = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

interface PermissionOverwrite {
    id: string;
    type: number;
    allow: string;
    deny: string;
}

interface FullChannel {
    id: string;
    name: string;
    type: number;
    parent_id: string | null;
    position: number;
    topic: string | null;
    nsfw: boolean;
    rateLimitPerUser: number;
    bitrate: number | null;
    userLimit: number | null;
    permissionOverwrites: PermissionOverwrite[];
    defaultAutoArchiveDuration?: number;
    flags?: number;
}

interface FullRole {
    id: string;
    name: string;
    color: number;
    hoist: boolean;
    position: number;
    permissions: string;
    mentionable: boolean;
    icon?: string | null;
    unicodeEmoji?: string | null;
}

let isCloning = false;
let progressBar: HTMLElement | null = null;
let notificationContainer: HTMLElement | null = null;

const VersionDisplay = () => {
    const [updateStatus, setUpdateStatus] = React.useState<string | null>(null);

    const checkUpdate = async () => {
        setUpdateStatus("Checking...");
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(UPDATE_CHECK_URL, {
                signal: controller.signal,
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                setUpdateStatus("Failed to check");
                return;
            }

            const data = await response.json();
            let latestVersion = data.tag_name || data.name || "";
            latestVersion = latestVersion.replace(/^v/i, '').trim();

            if (!latestVersion) {
                setUpdateStatus("No releases found");
                return;
            }

            const comparison = compareVersions(latestVersion, PLUGIN_VERSION);

            if (comparison > 0) {
                setUpdateStatus(`Update available: v${latestVersion}`);
                setTimeout(() => {
                    showUpdateModal(latestVersion, data.body || "No release notes available.");
                }, 500);
            } else {
                setUpdateStatus("You're up to date!");
            }
        } catch (e) {
            setUpdateStatus("Check failed");
        }
    };

    return (
        <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px",
            background: "var(--background-secondary)",
            borderRadius: "8px",
            marginBottom: "16px"
        }}>
            <div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--header-primary)" }}>
                    Server Cloner
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                    Version: <span style={{ color: "#5865f2", fontWeight: 600 }}>v{PLUGIN_VERSION}</span>
                    {updateStatus && (
                        <span style={{
                            marginLeft: "10px",
                            color: updateStatus.includes("available") ? "#43b581" :
                                updateStatus.includes("up to date") ? "#43b581" :
                                    updateStatus.includes("failed") || updateStatus.includes("Failed") ? "#f04747" : "var(--text-muted)"
                        }}>
                            • {updateStatus}
                        </span>
                    )}
                </div>
            </div>
            <button
                onClick={checkUpdate}
                disabled={updateStatus === "Checking..."}
                style={{
                    padding: "8px 16px",
                    borderRadius: "4px",
                    border: "none",
                    background: "#5865f2",
                    color: "white",
                    fontSize: "13px",
                    fontWeight: 500,
                    cursor: updateStatus === "Checking..." ? "not-allowed" : "pointer",
                    opacity: updateStatus === "Checking..." ? 0.7 : 1,
                    transition: "all 0.2s"
                }}
            >
                {updateStatus === "Checking..." ? "Checking..." : "Check for Updates"}
            </button>
        </div>
    );
};

const settings = definePluginSettings({
    versionInfo: {
        type: OptionType.COMPONENT,
        description: "",
        component: VersionDisplay
    },
    channelDelay: {
        type: OptionType.SLIDER,
        description: "Base delay between API requests (ms) - actual delay varies randomly",
        default: 800,
        markers: [500, 800, 1000, 1500, 2000],
        stickToMarkers: false
    }
});

function injectStyles() {
    if (document.getElementById("server-cloner-styles")) return;

    const style = document.createElement("style");
    style.id = "server-cloner-styles";
    style.textContent = `
        @keyframes shimmer {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeOut {
            from { opacity: 1; transform: translateY(0); }
            to { opacity: 0; transform: translateY(-20px); }
        }
        @keyframes progressShrink {
            from { width: 100%; }
            to { width: 0%; }
        }
        
        .cloner-notification-container {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 99999;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: none;
            align-items: center;
        }
        
        .cloner-notification {
            background: rgba(0, 0, 0, 0.45);
            backdrop-filter: blur(24px) saturate(180%);
            -webkit-backdrop-filter: blur(24px) saturate(180%);
            border-radius: 14px;
            padding: 16px 24px;
            min-width: 400px;
            max-width: 500px;
            box-shadow: 
                0 8px 32px rgba(0, 0, 0, 0.5),
                0 0 0 1px rgba(255, 255, 255, 0.1),
                inset 0 1px 0 rgba(255, 255, 255, 0.1);
            pointer-events: auto;
            animation: fadeIn 0.3s ease-out;
            position: relative;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-left: 4px solid #5865f2;
        }
        
        .cloner-notification.success { border-left-color: #43b581; }
        .cloner-notification.error {
            border-left-color: #f04747;
            background: rgba(240, 71, 71, 0.15);
            border: 1px solid rgba(240, 71, 71, 0.3);
            border-left: 4px solid #f04747;
        }
        .cloner-notification.info { border-left-color: #5865f2; }
        .cloner-notification.hiding { animation: fadeOut 0.3s ease-out forwards; }
        
        .cloner-notification-content {
            display: flex;
            align-items: center;
            gap: 14px;
        }
        
        .cloner-notification-icon {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            flex-shrink: 0;
            font-weight: bold;
            color: white;
        }
        
        .cloner-notification-icon.success { background: #43b581; }
        .cloner-notification-icon.error { background: #f04747; }
        .cloner-notification-icon.info { background: #5865f2; }
        
        .cloner-notification-text { flex: 1; }
        
        .cloner-notification-title {
            font-weight: 600;
            font-size: 15px;
            color: #ffffff;
            margin-bottom: 4px;
        }
        
        .cloner-notification-body {
            font-size: 14px;
            color: #b9bbbe;
            line-height: 1.4;
        }
        
        .cloner-notification.error .cloner-notification-title,
        .cloner-notification.error .cloner-notification-body { color: #ffffff; }
        
        .cloner-notification-progress {
            position: absolute;
            bottom: 0;
            left: 0;
            height: 4px;
            background: linear-gradient(90deg, #5865f2, #7289da);
            background-size: 200% 100%;
            animation: shimmer 2s infinite, progressShrink var(--duration) linear forwards;
        }
        
        .cloner-notification.success .cloner-notification-progress {
            background: linear-gradient(90deg, #43b581, #3ca374);
        }
        .cloner-notification.error .cloner-notification-progress {
            background: linear-gradient(90deg, #f04747, #d84040);
        }
        
        .cloner-progress-bar {
            position: fixed;
            top: 0;
            left: 0;
            height: 4px;
            background: linear-gradient(90deg, #5865F2, #7289DA, #5865F2);
            background-size: 200% 100%;
            z-index: 99999;
            transition: width 0.3s ease;
            box-shadow: 0 0 20px rgba(88, 101, 242, 0.8);
            animation: shimmer 1.5s infinite;
        }

        .cloner-notification-actions {
            display: flex;
            gap: 8px;
            margin-top: 10px;
            padding-top: 8px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
        }

        .cloner-notification-close {
            position: absolute;
            top: 8px;
            right: 10px;
            background: transparent;
            border: none;
            color: rgba(255, 255, 255, 0.5);
            font-size: 18px;
            cursor: pointer;
            padding: 0;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            transition: all 0.2s;
        }
        .cloner-notification-close:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }

        .cloner-btn {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #ddd;
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
            font-weight: 500;
        }
        .cloner-btn:hover {
            background: rgba(255, 255, 255, 0.2);
            color: #fff;
            transform: translateY(-1px);
        }
        .cloner-btn.danger {
            background: rgba(240, 71, 71, 0.2);
            border-color: rgba(240, 71, 71, 0.4);
            color: #ffcccc;
        }
        .cloner-btn.danger:hover {
            background: rgba(240, 71, 71, 0.4);
        }
    `;
    document.head.appendChild(style);
}

function removeStyles() {
    document.getElementById("server-cloner-styles")?.remove();
    document.getElementById("cloner-notification-container")?.remove();
    progressBar?.remove();
    progressBar = null;
}

function getNotificationContainer(): HTMLElement {
    if (!notificationContainer || !document.body.contains(notificationContainer)) {
        notificationContainer = document.createElement("div");
        notificationContainer.id = "cloner-notification-container";
        notificationContainer.className = "cloner-notification-container";
        document.body.appendChild(notificationContainer);
    }
    return notificationContainer;
}

interface NotificationAction {
    label: string;
    onClick: (id: string) => void;
    type?: "default" | "danger";
    id?: string;
}

function notify(
    title: string,
    body: string,
    type: "success" | "info" | "error" = "info",
    duration = 3000,
    actions: NotificationAction[] = []
): string {
    const container = getNotificationContainer();
    const actualDuration = type === "error" ? 8000 : duration;
    const notificationId = `notification-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    if (duration !== 0) {
        const existingNotifications = container.querySelectorAll(".cloner-notification:not(.hiding)");
        if (existingNotifications.length > 4) {
            const oldest = existingNotifications[0];
            oldest.classList.add("hiding");
            setTimeout(() => oldest.remove(), 300);
        }
    }

    const notification = document.createElement("div");
    notification.className = `cloner-notification ${type}`;
    notification.id = notificationId;
    if (duration !== 0) {
        notification.style.setProperty("--duration", `${actualDuration}ms`);
    }

    const icons: Record<string, string> = { success: "✓", error: "✕", info: "⚡" };
    const actionButtons = actions.map((action, index) => {
        const safeId = `btn-${index}-${action.label.replace(/\s+/g, '-')}`;
        return `<button id="${safeId}" class="cloner-btn ${action.type || 'default'}" data-action-index="${index}">${action.label}</button>`;
    }).join("");

    notification.innerHTML = `
        <button class="cloner-notification-close">×</button>
        <div class="cloner-notification-content">
            <div class="cloner-notification-icon ${type}">${icons[type]}</div>
            <div class="cloner-notification-text">
                <div class="cloner-notification-title">${title}</div>
                <div class="cloner-notification-body">${body}</div>
                ${actions.length > 0 ? `<div class="cloner-notification-actions">${actionButtons}</div>` : ''}
            </div>
        </div>
        ${duration !== 0 ? '<div class="cloner-notification-progress"></div>' : ''}
    `;

    container.appendChild(notification);

    const closeBtn = notification.querySelector(".cloner-notification-close");
    if (closeBtn) {
        closeBtn.addEventListener("click", () => {
            closeNotification(notificationId);
        });
    }

    actions.forEach((action, index) => {
        const safeId = `btn-${index}-${action.label.replace(/\s+/g, '-')}`;
        const btn = notification.querySelector(`#${safeId}`);
        if (btn) {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                action.onClick(notificationId);
            });
        }
    });

    if (duration !== 0) {
        setTimeout(() => {
            closeNotification(notificationId);
        }, actualDuration);
    }

    return notificationId;
}

function updateNotification(id: string, body: string) {
    const notification = document.getElementById(id);
    if (notification) {
        const bodyEl = notification.querySelector(".cloner-notification-body");
        if (bodyEl) bodyEl.textContent = body;
    }
}

function closeNotification(id: string) {
    const notification = document.getElementById(id);
    if (notification && !notification.classList.contains("hiding")) {
        notification.classList.add("hiding");
        setTimeout(() => notification.remove(), 300);
    }
}

function createProgressBar(): HTMLElement {
    if (progressBar) return progressBar;

    progressBar = document.createElement("div");
    progressBar.id = "cloner-progress-bar";
    progressBar.className = "cloner-progress-bar";
    progressBar.style.width = "0%";
    document.body.appendChild(progressBar);
    return progressBar;
}

function updateProgress(percent: number) {
    if (progressBar) {
        progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    }
}

function removeProgressBar() {
    if (progressBar) {
        progressBar.style.width = "100%";
        setTimeout(() => {
            progressBar?.remove();
            progressBar = null;
        }, 500);
    }
}

function safeGet(obj: any, prop: string, defaultValue: any = undefined): any {
    try {
        if (!obj || typeof obj !== "object") return defaultValue;
        return obj[prop] ?? defaultValue;
    } catch {
        return defaultValue;
    }
}

function extractChannels(guildId: string, includeHidden = false): any[] {
    try {
        const channelsData = GuildChannelStore.getChannels(guildId, includeHidden);
        if (!channelsData) return [];

        const channels: any[] = [];
        const seen = new Set<string>();

        if (Array.isArray(channelsData)) {
            channelsData.forEach(item => {
                const channel = item?.channel || item;
                if (channel?.id && !seen.has(channel.id)) {
                    seen.add(channel.id);
                    channels.push(channel);
                }
            });
        } else if (typeof channelsData === "object") {
            for (const key in channelsData) {
                const value = channelsData[key];
                if (Array.isArray(value)) {
                    value.forEach(item => {
                        const channel = item?.channel || item;
                        if (channel?.id && !seen.has(channel.id)) {
                            seen.add(channel.id);
                            channels.push(channel);
                        }
                    });
                }
            }
        }

        return channels;
    } catch (e) {
        return [];
    }
}

function getChannelPermissionOverwrites(channelId: string): PermissionOverwrite[] {
    try {
        const channel = ChannelStore.getChannel(channelId);
        if (!channel?.permissionOverwrites) return [];

        const overwrites: PermissionOverwrite[] = [];
        for (const [id, overwrite] of Object.entries(channel.permissionOverwrites)) {
            const ow = overwrite as any;
            overwrites.push({
                id: id,
                type: ow.type,
                allow: ow.allow?.toString() || "0",
                deny: ow.deny?.toString() || "0"
            });
        }
        return overwrites;
    } catch (e) {
        return [];
    }
}

function normalizeChannel(ch: any): FullChannel | null {
    try {
        let bitrate = safeGet(ch, "bitrate", null);
        if (bitrate && bitrate > 96000) bitrate = 96000;
        if (bitrate && bitrate < 8000) bitrate = 64000;

        const permissionOverwrites = getChannelPermissionOverwrites(ch.id);

        return {
            id: safeGet(ch, "id", ""),
            name: safeGet(ch, "name", "unnamed-channel"),
            type: safeGet(ch, "type", 0),
            parent_id: safeGet(ch, "parent_id") || safeGet(ch, "parentId") || null,
            position: safeGet(ch, "position", 0),
            topic: safeGet(ch, "topic", null),
            nsfw: safeGet(ch, "nsfw", false),
            rateLimitPerUser: safeGet(ch, "rateLimitPerUser") || safeGet(ch, "rate_limit_per_user") || 0,
            bitrate: bitrate,
            userLimit: safeGet(ch, "userLimit") || safeGet(ch, "user_limit") || null,
            permissionOverwrites: permissionOverwrites,
            defaultAutoArchiveDuration: safeGet(ch, "defaultAutoArchiveDuration", null),
            flags: safeGet(ch, "flags", 0),
        };
    } catch (e) {
        return null;
    }
}

function normalizeRole(role: Role): FullRole {
    return {
        id: role.id,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        position: role.position,
        permissions: role.permissions.toString(),
        mentionable: role.mentionable,
        icon: (role as any).icon || null,
        unicodeEmoji: (role as any).unicodeEmoji || null
    };
}

class RateLimiter {
    private lastRequest = 0;
    private baseDelay: number;

    constructor(baseDelay = 800) {
        this.baseDelay = baseDelay;
    }

    async wait() {
        const now = Date.now();
        const actualDelay = randomDelay(this.baseDelay, Math.floor(this.baseDelay * 1.5));
        const timeSinceLastRequest = now - this.lastRequest;
        if (timeSinceLastRequest < actualDelay) {
            await sleep(actualDelay - timeSinceLastRequest);
        }
        this.lastRequest = Date.now();
    }

    async execute<T>(fn: () => Promise<T>, statusUpdateCb?: (msg: string) => void, exitCondition?: () => boolean, retries = 3): Promise<T> {
        for (let i = 0; i < retries; i++) {
            try {
                if (!isCloning) throw new Error("Cancelled");
                if (exitCondition && exitCondition()) throw new Error("Skipped");

                await this.wait();
                return await fn();
            } catch (e: any) {
                if (!isCloning) throw new Error("Cancelled");
                if (exitCondition && exitCondition()) throw new Error("Skipped");

                if (e?.message === "Skipped" || e?.message === "Cancelled") throw e;

                if (e?.status === 429) {
                    const retryAfter = ((e.retry_after || e.body?.retry_after || 1) * 1000) + 500;
                    if (statusUpdateCb) statusUpdateCb(`Rate limited, waiting ${Math.ceil(retryAfter / 1000)}s...`);

                    this.baseDelay = Math.min(this.baseDelay * 2, 8000);

                    const chunkSize = 500;
                    let elapsed = 0;
                    while (elapsed < retryAfter) {
                        if (!isCloning) throw new Error("Cancelled");
                        if (exitCondition && exitCondition()) throw new Error("Skipped");
                        await sleep(chunkSize);
                        elapsed += chunkSize;
                    }

                    if (i < retries - 1) {
                        continue;
                    }
                }

                if (e?.status === 403 && i < retries - 1) {
                    if (statusUpdateCb) statusUpdateCb(`Permission sync... (retry ${i + 1})`);
                    await sleep(3000);
                    continue;
                }

                if (e?.status === 400) {
                    throw e;
                }

                if (i === retries - 1) throw e;
                if (exitCondition && exitCondition()) throw new Error("Skipped");
                await sleep(randomDelay(this.baseDelay, this.baseDelay * 2));
            }
        }
        throw new Error("Max retries exceeded");
    }
}

async function fetchGuildRoles(guildId: string): Promise<Role[]> {
    try {
        const rolesFromStore = GuildRoleStore.getSortedRoles(guildId);
        if (rolesFromStore && rolesFromStore.length > 0) {
            return rolesFromStore;
        }
        const response = await RestAPI.get({ url: `/guilds/${guildId}/roles` });
        return response.body || [];
    } catch (e) {
        return [];
    }
}

async function fetchGuildData(guildId: string): Promise<any> {
    try {
        const response = await RestAPI.get({ url: `/guilds/${guildId}` });
        return response.body || null;
    } catch (e) {
        return null;
    }
}

function navigateToGuild(guildId: string) {
    try {
        FluxDispatcher.dispatch({
            type: "CHANNEL_SELECT",
            guildId: guildId,
            channelId: null
        });
    } catch (e) {
        console.warn("[ServerCloner] Navigation failed:", e);
    }
}

async function checkForUpdates(): Promise<void> {
    if (!UPDATE_CHECK_ENABLED) return;

    try {
        const lastDismissed = await DataStore.get("ServerCloner-dismissed-version") as string | undefined;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(UPDATE_CHECK_URL, {
            signal: controller.signal,
            headers: { 'Accept': 'application/vnd.github.v3+json' }
        });

        clearTimeout(timeoutId);

        if (!response.ok) return;

        const data = await response.json();
        let latestVersion = data.tag_name || data.name || "";
        latestVersion = latestVersion.replace(/^v/i, '').trim();

        if (!latestVersion) return;

        const comparison = compareVersions(latestVersion, PLUGIN_VERSION);

        if (comparison > 0 && lastDismissed !== latestVersion) {
            const releaseNotes = data.body || "No release notes available.";
            showUpdateModal(latestVersion, releaseNotes);
        }
    } catch (e) {
        console.warn("[ServerCloner] Update check failed:", e);
    }
}

function compareVersions(v1: string, v2: string): number {
    const clean1 = v1.replace(/[^0-9.]/g, '');
    const clean2 = v2.replace(/[^0-9.]/g, '');

    const parts1 = clean1.split('.').map(n => parseInt(n) || 0);
    const parts2 = clean2.split('.').map(n => parseInt(n) || 0);

    const maxLength = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLength; i++) {
        const num1 = parts1[i] || 0;
        const num2 = parts2[i] || 0;

        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }

    return 0;
}

function showUpdateModal(version: string, releaseNotes: string) {
    const backdrop = document.createElement("div");
    backdrop.style.cssText = `
        position: fixed;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(0,0,0,0.7);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        z-index: 10000;
        animation: fadeIn 0.2s;
    `;

    const modalContent = document.createElement("div");
    modalContent.style.cssText = `
        position: fixed;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        background: var(--modal-background, #313338);
        border-radius: 16px;
        border: 1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.1));
        padding: 0;
        z-index: 10001;
        box-shadow: 0 24px 48px rgba(0,0,0,0.4);
        min-width: 420px;
        max-width: 480px;
        color: var(--header-primary, #fff);
        font-family: var(--font-primary);
        overflow: hidden;
    `;

    const formattedNotes = releaseNotes
        .replace(/#{1,6}\s/g, '')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, `<code style="background: var(--background-secondary, rgba(88,101,242,0.2)); padding: 2px 6px; border-radius: 4px; font-family: monospace;">$1</code>`)
        .replace(/\n/g, '<br>')
        .substring(0, 500);

    modalContent.innerHTML = `
        <div style="padding: 24px;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                <div>
                    <div style="color: var(--text-positive, #43b581); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;">Update Available</div>
                    <div style="font-size: 20px; font-weight: 600;">Server Cloner</div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="color: var(--text-muted, #9ca3af); font-size: 12px;">v${PLUGIN_VERSION}</span>
                    <span style="color: var(--text-muted, #9ca3af);">→</span>
                    <span style="background: var(--text-positive, #43b581); color: white; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;">v${version}</span>
                </div>
            </div>

            <div style="background: var(--background-secondary, rgba(0,0,0,0.2)); border-radius: 12px; padding: 16px; margin-bottom: 16px; max-height: 200px; overflow-y: auto;">
                <div style="color: var(--text-muted, #9ca3af); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px;">What's New</div>
                <div style="font-size: 13px; line-height: 1.6; color: var(--text-normal, #dbdee1);">${formattedNotes}</div>
            </div>

            <div style="display: flex; gap: 10px;">
                <button id="update-modal-dismiss" style="
                    flex: 1;
                    padding: 12px;
                    border: none;
                    border-radius: 4px;
                    background: var(--button-secondary-background, rgba(255,255,255,0.1));
                    color: var(--text-normal, #fff);
                    cursor: pointer;
                ">Later</button>
                <button id="update-modal-download" style="
                    flex: 1;
                    padding: 12px;
                    border: none;
                    border-radius: 4px;
                    background: var(--button-positive-background, #23a559);
                    color: white;
                    cursor: pointer;
                ">Update Now</button>
            </div>
        </div>
    `;

    const cleanup = () => {
        try {
            backdrop.remove();
            modalContent.remove();
        } catch (e) {
            console.warn("[ServerCloner] Modal cleanup error:", e);
        }
    };

    backdrop.onclick = cleanup;
    document.body.appendChild(backdrop);
    document.body.appendChild(modalContent);

    setTimeout(() => {
        const dismissBtn = document.getElementById("update-modal-dismiss");
        const downloadBtn = document.getElementById("update-modal-download");

        if (dismissBtn) {
            dismissBtn.onclick = async () => {
                await DataStore.set('ServerCloner-dismissed-version', version);
                cleanup();
            };
        }

        if (downloadBtn) {
            downloadBtn.onclick = async () => {
                window.open(GITHUB_RELEASE_URL, '_blank');
                await DataStore.set('ServerCloner-dismissed-version', version);
                cleanup();
            };
        }
    }, 10);
}

function checkGuildExistence(sourceId: string, targetId: string) {
    if (!GuildStore.getGuild(sourceId)) throw new Error("Original server is gone");
    if (!GuildStore.getGuild(targetId)) throw new Error("Target server is gone");
}

async function cloneServer(sourceGuild: Guild) {
    if (isCloning) {
        notify("Already Cloning", "Please wait for the current clone to finish", "error");
        return;
    }

    isCloning = true;
    injectStyles();
    createProgressBar();

    checkForUpdates().catch(() => { });

    let rolesFailed = 0;
    let channelsFailed = 0;

    const roleRateLimiter = new RateLimiter(settings.store.channelDelay);
    const channelRateLimiter = new RateLimiter(settings.store.channelDelay);

    try {
        const guild = GuildStore.getGuild(sourceGuild.id);
        if (!guild) throw new Error("Server not found");

        const estimateChannels = extractChannels(sourceGuild.id, true);
        const estimateRoles = await fetchGuildRoles(sourceGuild.id);
        const totalItems = estimateRoles.length + estimateChannels.length;
        const estimatedSeconds = Math.ceil((totalItems * settings.store.channelDelay) / 1000);
        const estimatedMinutes = Math.floor(estimatedSeconds / 60);
        const remainingSeconds = estimatedSeconds % 60;
        const timeStr = estimatedMinutes > 0
            ? `~${estimatedMinutes}m ${remainingSeconds}s`
            : `~${estimatedSeconds}s`;

        notify("Cloning Server", `Starting to clone "${guild.name}"...\nEstimated time: ${timeStr}`, "info");
        updateProgress(5);

        const fullGuildData = await fetchGuildData(sourceGuild.id);

        const rawChannels = extractChannels(sourceGuild.id, true);
        const channels = rawChannels
            .map(ch => normalizeChannel(ch))
            .filter((ch): ch is FullChannel => ch !== null && ch.id !== "");

        let iconBase64: string | null = null;
        let bannerBase64: string | null = null;
        let splashBase64: string | null = null;

        await Promise.all([
            (async () => {
                if (guild.icon) {
                    try {
                        const iconUrl = `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=512`;
                        const response = await fetch(iconUrl);
                        if (response.ok) {
                            const iconData = await response.arrayBuffer();
                            iconBase64 = `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(iconData)))}`;
                        }
                    } catch (e) {
                        console.warn("[ServerCloner] Failed to fetch icon:", e);
                    }
                }
            })(),
            (async () => {
                if ((guild as any).banner) {
                    try {
                        const bannerUrl = `https://cdn.discordapp.com/banners/${guild.id}/${(guild as any).banner}.png?size=512`;
                        const response = await fetch(bannerUrl);
                        if (response.ok) {
                            const bannerData = await response.arrayBuffer();
                            bannerBase64 = `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(bannerData)))}`;
                        }
                    } catch (e) {
                        console.warn("[ServerCloner] Failed to fetch banner:", e);
                    }
                }
            })(),
            (async () => {
                if ((guild as any).splash) {
                    try {
                        const splashUrl = `https://cdn.discordapp.com/splashes/${guild.id}/${(guild as any).splash}.png?size=512`;
                        const response = await fetch(splashUrl);
                        if (response.ok) {
                            const splashData = await response.arrayBuffer();
                            splashBase64 = `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(splashData)))}`;
                        }
                    } catch (e) {
                        console.warn("[ServerCloner] Failed to fetch splash:", e);
                    }
                }
            })()
        ]);

        updateProgress(15);

        const isCommunity = fullGuildData?.features?.includes("COMMUNITY") || false;

        const payload: any = {
            name: guild.name + " (Clone)",
            verification_level: safeGet(guild, "verificationLevel", 0),
            default_message_notifications: safeGet(guild, "defaultMessageNotifications", 0),
            explicit_content_filter: safeGet(guild, "explicitContentFilter", 0),
            afk_timeout: safeGet(guild, "afkTimeout", 300),
            preferred_locale: fullGuildData?.preferred_locale || "en-US",
        };

        if (iconBase64) payload.icon = iconBase64;

        const createResponse = await RestAPI.post({ url: "/guilds", body: payload });
        if (!createResponse?.body?.id) throw new Error("Failed to create server");

        const newGuildId = createResponse.body.id;

        await sleep(2500);

        navigateToGuild(newGuildId);
        await sleep(500);

        updateProgress(20);

        const defaultChannels = extractChannels(newGuildId, false).filter(c => c && c.id);
        for (const channel of defaultChannels) {
            if (!channel?.id) continue;
            try {
                await RestAPI.del({ url: `/channels/${channel.id}` });
                await sleep(200);
            } catch (e) {
                console.warn("[ServerCloner] Failed to delete default channel:", e);
            }
        }

        updateProgress(25);

        const roles = await fetchGuildRoles(sourceGuild.id);
        const sortedRoles = roles.filter(r => r.name !== "@everyone").sort((a, b) => a.position - b.position);
        const roleIdMap: Record<string, string> = {};

        const everyoneRole = roles.find(r => r.name === "@everyone");
        if (everyoneRole) {
            try {
                const newRoles = await fetchGuildRoles(newGuildId);
                const newEveryoneRole = newRoles.find(r => r.name === "@everyone");
                if (newEveryoneRole) {
                    roleIdMap[everyoneRole.id] = newEveryoneRole.id;
                    await RestAPI.patch({
                        url: `/guilds/${newGuildId}/roles/${newEveryoneRole.id}`,
                        body: {
                            permissions: everyoneRole.permissions.toString()
                        }
                    });
                }
            } catch (e) {
                console.warn("[ServerCloner] Failed to update @everyone role:", e);
            }
        }

        const categories = channels.filter(c => c.type === 4);
        const otherChannels = channels.filter(c => c.type !== 4);

        let skipRoles = false;
        const roleNotifId = notify("Cloning Roles", "Starting in 2s...", "info", 0, [
            { label: "Skip Roles", type: "danger", onClick: () => { skipRoles = true; } }
        ]);

        for (let i = 2; i > 0; i--) {
            if (skipRoles || !isCloning) break;
            updateNotification(roleNotifId, `Starting roles in ${i}s...`);
            await sleep(1000);
        }

        if (skipRoles) {
            updateNotification(roleNotifId, "Skipped roles.");
            setTimeout(() => closeNotification(roleNotifId), 1000);
            updateProgress(55);
        } else {
            let roleStep = 0;
            updateNotification(roleNotifId, `Starting to clone ${sortedRoles.length} roles...`);

            for (const role of sortedRoles) {
                if (!isCloning) break;
                if (skipRoles) break;

                try {
                    checkGuildExistence(sourceGuild.id, newGuildId);
                    roleStep++;
                    updateNotification(roleNotifId, `Cloning role ${roleStep}/${sortedRoles.length}: ${role.name}`);
                    updateProgress(25 + ((roleStep / sortedRoles.length) * 30));

                    const normalized = normalizeRole(role);
                    const rolePayload: any = {
                        name: normalized.name,
                        color: normalized.color,
                        hoist: normalized.hoist,
                        mentionable: normalized.mentionable,
                        permissions: normalized.permissions
                    };

                    if (normalized.unicodeEmoji) {
                        rolePayload.unicode_emoji = normalized.unicodeEmoji;
                    }

                    const response = await roleRateLimiter.execute(async () => {
                        return await RestAPI.post({
                            url: `/guilds/${newGuildId}/roles`,
                            body: rolePayload
                        });
                    }, (msg) => updateNotification(roleNotifId, `${msg} (Role ${roleStep}/${sortedRoles.length})`), () => skipRoles);

                    if (response?.body?.id) {
                        roleIdMap[role.id] = response.body.id;
                    }
                } catch (e) {
                    rolesFailed++;
                }
            }
            closeNotification(roleNotifId);
        }

        updateProgress(60);
        notify("Roles Done", `Roles cloned. Starting channels...`, "success", 2000);

        const channelIdMap: Record<string, string> = {};

        const channelNotifId = notify("Cloning Channels", `Creating ${categories.length + otherChannels.length} channels...`, "info", 0);

        const sortedCategories = categories.sort((a, b) => a.position - b.position);

        let catStored = 0;
        for (const cat of sortedCategories) {
            checkGuildExistence(sourceGuild.id, newGuildId);
            if (!isCloning) break;
            catStored++;

            try {
                updateNotification(channelNotifId, `Cloning category ${catStored}/${sortedCategories.length}: ${cat.name}`);

                const catPayload: any = {
                    name: cat.name,
                    type: 4,
                    position: cat.position
                };

                if (cat.permissionOverwrites.length > 0) {
                    const mappedOverwrites = cat.permissionOverwrites
                        .filter(ow => ow.type === 0 && roleIdMap[ow.id])
                        .map(ow => ({
                            id: roleIdMap[ow.id],
                            type: ow.type,
                            allow: ow.allow,
                            deny: ow.deny
                        }));
                    if (mappedOverwrites.length > 0) {
                        catPayload.permission_overwrites = mappedOverwrites;
                    }
                }

                const response = await channelRateLimiter.execute(async () => {
                    return await RestAPI.post({
                        url: `/guilds/${newGuildId}/channels`,
                        body: catPayload
                    });
                }, (msg) => updateNotification(channelNotifId, `${msg} (Cat ${catStored}/${sortedCategories.length})`));

                if (response?.body?.id) {
                    channelIdMap[cat.id] = response.body.id;
                }
            } catch (e) {
                channelsFailed++;
            }
        }

        const sortedOtherChannels = otherChannels.sort((a, b) => a.position - b.position);
        let chStored = 0;

        for (const ch of sortedOtherChannels) {
            checkGuildExistence(sourceGuild.id, newGuildId);
            if (!isCloning) break;
            chStored++;

            const chPayload: any = {
                name: ch.name,
                type: ch.type,
                parent_id: ch.parent_id ? (channelIdMap[ch.parent_id] || null) : null,
                position: ch.position,
            };

            if (ch.topic) chPayload.topic = ch.topic;
            if (ch.nsfw) chPayload.nsfw = ch.nsfw;
            if (ch.rateLimitPerUser) chPayload.rate_limit_per_user = ch.rateLimitPerUser;
            if (ch.defaultAutoArchiveDuration) chPayload.default_auto_archive_duration = ch.defaultAutoArchiveDuration;

            if (ch.type === 2 || ch.type === 13) {
                if (ch.bitrate) chPayload.bitrate = ch.bitrate;
                if (ch.userLimit) chPayload.user_limit = ch.userLimit;
            }

            if (ch.permissionOverwrites.length > 0) {
                const mappedOverwrites = ch.permissionOverwrites
                    .filter(ow => ow.type === 0 && roleIdMap[ow.id])
                    .map(ow => ({
                        id: roleIdMap[ow.id],
                        type: ow.type,
                        allow: ow.allow,
                        deny: ow.deny
                    }));
                if (mappedOverwrites.length > 0) {
                    chPayload.permission_overwrites = mappedOverwrites;
                }
            }

            try {
                const totalProgress = 70 + ((chStored / sortedOtherChannels.length) * 25);
                updateProgress(totalProgress);
                updateNotification(channelNotifId, `Cloning channel ${chStored}/${sortedOtherChannels.length}: ${ch.name}`);

                await channelRateLimiter.execute(async () => {
                    await RestAPI.post({ url: `/guilds/${newGuildId}/channels`, body: chPayload });
                }, (msg) => updateNotification(channelNotifId, `${msg} (Ch ${chStored}/${sortedOtherChannels.length})`));
            } catch (e) {
                channelsFailed++;
            }
        }

        closeNotification(channelNotifId);

        notify("Channels Complete", `Created ${categories.length + otherChannels.length - channelsFailed} channels`, "success", 2000);

        if (isCommunity) {
            try {
                const newChannelsRaw = extractChannels(newGuildId, false);
                const rulesChannel = newChannelsRaw.find((c: any) => c.name?.toLowerCase().includes("rule") || c.name?.toLowerCase().includes("rules"));
                const updatesChannel = newChannelsRaw.find((c: any) =>
                    c.name?.toLowerCase().includes("update") ||
                    c.name?.toLowerCase().includes("news") ||
                    c.name?.toLowerCase().includes("announcement")
                );

                const firstTextChannel = newChannelsRaw.find((c: any) => c.type === 0);

                const communityPayload: any = {
                    features: ["COMMUNITY"],
                    verification_level: Math.max(safeGet(guild, "verificationLevel", 1), 1),
                    explicit_content_filter: 2,
                    rules_channel_id: rulesChannel?.id || firstTextChannel?.id || null,
                    public_updates_channel_id: updatesChannel?.id || firstTextChannel?.id || null
                };

                if (fullGuildData?.description) {
                    communityPayload.description = fullGuildData.description;
                }

                await channelRateLimiter.execute(async () => {
                    await RestAPI.patch({
                        url: `/guilds/${newGuildId}`,
                        body: communityPayload
                    });
                });
            } catch (e) {
                console.warn("[ServerCloner] Failed to enable community features:", e);
            }
        }

        if (bannerBase64 || splashBase64 || fullGuildData?.description) {
            try {
                const updatePayload: any = {};
                if (bannerBase64) updatePayload.banner = bannerBase64;
                if (splashBase64) updatePayload.splash = splashBase64;
                if (fullGuildData?.description) updatePayload.description = fullGuildData.description;

                await channelRateLimiter.execute(async () => {
                    await RestAPI.patch({
                        url: `/guilds/${newGuildId}`,
                        body: updatePayload
                    });
                });
            } catch (e) {
                console.warn("[ServerCloner] Failed to update guild assets:", e);
            }
        }

        updateProgress(100);

        const totalFailed = rolesFailed + channelsFailed;
        if (totalFailed > 0) {
            notify("Clone Complete", `Cloned with ${totalFailed} errors`, "success", 5000);
        } else {
            notify("Clone Complete!", `Successfully cloned "${guild.name}"!`, "success", 5000);
        }

    } catch (e: any) {
        notify("Clone Failed", e.message || "An error occurred while cloning", "error");
    } finally {
        isCloning = false;
        removeProgressBar();
    }
}

const CloneIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
    </svg>
);

const guildContextMenuPatch: NavContextMenuPatchCallback = (children: any[], props: { guild?: Guild; }) => {
    if (!props?.guild) return;

    const group = findGroupChildrenByChildId("privacy", children);
    const menuItem = (
        <Menu.MenuItem
            id="clone-server-pro"
            label="Clone Server"
            action={() => cloneServer(props.guild!)}
            icon={CloneIcon}
        />
    );

    if (group) {
        group.push(menuItem);
    } else {
        children.push(<Menu.MenuGroup>{menuItem}</Menu.MenuGroup>);
    }
};

export default definePlugin({
    name: "ServerCloner",
    description: "Clone servers with channels, roles, permissions and community features",
    authors: [{ name: "Moret", id: 1172069050424250432n }],
    settings,

    start() {
        injectStyles();
        setTimeout(() => checkForUpdates(), 5000);
    },

    stop() {
        removeStyles();
    },

    patches: [
        {
            find: '"GuildChannelStore"',
            replacement: [
                {
                    match: /isChannelGated\(.+?\)(?=&&)/,
                    replace: (m: string) => `${m}&&false`
                },
                {
                    match: /(?<=getChannels\(\i)(\){.*?)return (.+?)}/,
                    replace: (_: string, rest: string, channels: string) => `,shouldIncludeHidden${rest}return shouldIncludeHidden?${channels}:${channels};}`
                },
            ]
        }
    ],

    contextMenus: {
        "guild-context": guildContextMenuPatch,
        "guild-header-popout": guildContextMenuPatch
    }
});
