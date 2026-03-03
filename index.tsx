
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { Guild, Role } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { Button, Checkbox, GuildRoleStore, GuildStore, Menu, NavigationRouter, React, RestAPI, SearchableSelect, UserStore } from "@webpack/common";

import "./styles.css";

const GuildChannelStore = findStoreLazy("GuildChannelStore");

const PLUGIN_VERSION = "2.0.0";
const GITHUB_REPO = "BlockTol/Discord-Server-Cloner";
const UPDATE_CHECK_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASE_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const UPDATE_CHECK_ENABLED = true;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const randomDelay = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

function escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

let isCloning = false;
let notificationContainer: HTMLElement | null = null;
let mainProgressNotificationId: string | null = null;
let currentCloneGuildId: string | null = null;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk as any);
    }
    return btoa(binary);
}

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

function cleanupContainer() {
    document.getElementById("cloner-notification-container")?.remove();
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
                <div class="cloner-notification-title">${escapeHtml(title)}</div>
                <div class="cloner-notification-body">${escapeHtml(body)}</div>
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

function closeNotification(id: string) {
    const notification = document.getElementById(id);
    if (notification && !notification.classList.contains("hiding")) {
        notification.classList.add("hiding");
        setTimeout(() => notification.remove(), 300);
    }
}

let skipRolesCallback: (() => void) | null = null;

function createMainProgressNotification(title: string, initialBody: string, onSkipRoles?: () => void, isExistingServer: boolean = false, showSkipRoles: boolean = true): string {
    skipRolesCallback = onSkipRoles || null;
    const container = getNotificationContainer();
    const notificationId = `main-progress-${Date.now()}`;

    const notification = document.createElement("div");
    notification.className = `cloner-notification info`;
    notification.id = notificationId;
    notification.style.minWidth = "450px";

    const cancelBtnText = isExistingServer ? "Cancel" : "Cancel & Delete";
    const cancelBtnClass = isExistingServer ? "cloner-btn" : "cloner-btn danger";

    const skipRolesBtnHtml = showSkipRoles ? `<button class="cloner-btn cloner-skip-roles-btn" style="display:none">Skip Roles</button>` : '';

    notification.innerHTML = `
        <div class="cloner-notification-content">
            <div class="cloner-notification-icon info">●</div>
            <div class="cloner-notification-text">
                <div class="cloner-notification-title" style="display: flex; justify-content: space-between; align-items: center;">
                    <span>${escapeHtml(title)}</span>
                    <span class="cloner-notification-timer" style="font-size: 11px; font-weight: 700; background: rgba(255,255,255,0.1); padding: 2px 6px; borderRadius: 4px; color: var(--text-muted);"></span>
                </div>
                <div class="cloner-notification-body">${escapeHtml(initialBody)}</div>
                <div class="cloner-progress-inline">
                    <div class="cloner-progress-inline-bar" style="width: 0%"></div>
                </div>
                <div class="cloner-notification-actions">
                    ${skipRolesBtnHtml}
                    <button class="${cancelBtnClass} cloner-cancel-btn">${cancelBtnText}</button>
                </div>
            </div>
        </div>
    `;

    container.insertBefore(notification, container.firstChild);

    const skipRolesBtn = notification.querySelector(".cloner-skip-roles-btn");
    if (skipRolesBtn) {
        skipRolesBtn.addEventListener("click", () => {
            if (skipRolesCallback) skipRolesCallback();
            (skipRolesBtn as HTMLButtonElement).disabled = true;
            (skipRolesBtn as HTMLButtonElement).textContent = "Skipped";
        });
    }

    const cancelBtn = notification.querySelector(".cloner-cancel-btn");
    if (cancelBtn) {
        cancelBtn.addEventListener("click", async () => {
            isCloning = false;

            if (!isExistingServer && currentCloneGuildId) {
                try {
                    await RestAPI.del({ url: `/guilds/${currentCloneGuildId}` });
                    updateMainProgress(notificationId, "Cancelled - Server deleted", 100);
                } catch (e) {
                    updateMainProgress(notificationId, "Cancelled - Could not delete server", 100);
                }
                currentCloneGuildId = null;
            } else {
                updateMainProgress(notificationId, "Cancelled", 100);
            }

            setTimeout(() => closeNotification(notificationId), 2000);
        });
    }

    return notificationId;
}

function updateMainProgress(id: string, body: string, percent: number) {
    const safePercent = isNaN(percent) ? 0 : Math.min(100, Math.max(0, percent));
    const notification = document.getElementById(id);
    if (notification) {
        const bodyEl = notification.querySelector(".cloner-notification-body");
        if (bodyEl) bodyEl.textContent = body;

        const progressBar = notification.querySelector(".cloner-progress-inline-bar") as HTMLElement;
        if (progressBar) {
            progressBar.style.width = `${safePercent}%`;
        }
    }
}

function completeMainProgress(id: string, body: string, success: boolean) {
    const notification = document.getElementById(id);
    if (notification) {
        const bodyEl = notification.querySelector(".cloner-notification-body");
        if (bodyEl) bodyEl.textContent = body;

        const progressBar = notification.querySelector(".cloner-progress-inline-bar") as HTMLElement;
        if (progressBar) {
            progressBar.style.width = "100%";
            if (success) progressBar.classList.add("success");
        }

        const icon = notification.querySelector(".cloner-notification-icon");
        if (icon) {
            icon.className = `cloner-notification-icon ${success ? 'success' : 'error'}`;
            icon.textContent = success ? '✓' : '✕';
        }

        notification.classList.remove('info');
        notification.classList.add(success ? 'success' : 'error');

        const timerEl = notification.querySelector(".cloner-notification-timer");
        if (timerEl) {
            timerEl.textContent = "0:00";
            if (success) (timerEl as HTMLElement).style.background = "rgba(67, 181, 129, 0.2)";
        }

        setTimeout(() => closeNotification(id), 5000);
    }
}

function updateProgress(percent: number, message?: string) {
    if (mainProgressNotificationId) {
        updateMainProgress(mainProgressNotificationId, message || `Progress: ${Math.round(percent)}%`, percent);
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

class RateLimiter {
    private lastRequest = 0;
    private baseDelay: number;
    private consecutive429 = 0;
    private static readonly MAX_CONSECUTIVE_429 = 10;

    constructor(baseDelay = 800) {
        this.baseDelay = baseDelay;
    }

    async wait(exitCondition?: () => boolean) {
        const now = Date.now();
        const actualDelay = randomDelay(this.baseDelay, Math.floor(this.baseDelay * 1.5));
        const timeSinceLastRequest = now - this.lastRequest;
        if (timeSinceLastRequest < actualDelay) {
            const remaining = actualDelay - timeSinceLastRequest;
            const chunk = 200;
            let elapsed = 0;
            while (elapsed < remaining) {
                if (!isCloning) throw new Error("Cancelled");
                if (exitCondition && exitCondition()) throw new Error("Skipped");
                await sleep(Math.min(chunk, remaining - elapsed));
                elapsed += chunk;
            }
        }
        this.lastRequest = Date.now();
    }

    async execute<T>(fn: () => Promise<T>, statusUpdateCb?: (msg: string) => void, exitCondition?: () => boolean, retries = 3): Promise<T> {
        for (let i = 0; i < retries; i++) {
            try {
                if (!isCloning) throw new Error("Cancelled");
                if (exitCondition && exitCondition()) throw new Error("Skipped");

                await this.wait(exitCondition);
                if (!isCloning) throw new Error("Cancelled");
                if (exitCondition && exitCondition()) throw new Error("Skipped");
                const result = await fn();

                this.consecutive429 = 0;
                if (this.baseDelay > 800) {
                    this.baseDelay = Math.max(800, this.baseDelay / 2);
                }

                return result;
            } catch (e: any) {
                if (!isCloning) throw new Error("Cancelled");
                if (exitCondition && exitCondition()) throw new Error("Skipped");

                if (e?.message === "Skipped" || e?.message === "Cancelled") throw e;

                if (e?.status === 429) {
                    this.consecutive429++;
                    if (this.consecutive429 >= RateLimiter.MAX_CONSECUTIVE_429) {
                        const err: any = new Error("RateLimitExhausted");
                        err.rateLimitExhausted = true;
                        throw err;
                    }

                    const retryAfter = ((e.retry_after || e.body?.retry_after || 1) * 1000) + 500;
                    if (statusUpdateCb) statusUpdateCb(`Rate limited, waiting ${Math.ceil(retryAfter / 1000)}s...`);

                    this.baseDelay = Math.min(this.baseDelay * 1.5, 5000);

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

                if (e?.status === 403) {
                    let errorCode = e?.body?.code || 0;
                    if (!errorCode && e?.text) {
                        try { errorCode = JSON.parse(e.text)?.code || 0; } catch (_) { }
                    }

                    if (errorCode === 50101) {
                        throw e;
                    }

                    if (i < retries - 1) {
                        const backoff = Math.min(2000 + (i * 2000), 10000);
                        console.warn(`[ServerCloner] 403 Forbidden (code: ${errorCode}), retrying ${i + 1}/${retries} in ${backoff / 1000}s...`);
                        await sleep(backoff);
                        continue;
                    }
                    throw e;
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

const UpdateModal = ({ props, version, releaseNotes }: { props: ModalProps; version: string; releaseNotes: string; }) => {
    const cleanNotes = releaseNotes
        .replace(/#{1,6}\s/g, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/`(.*?)`/g, '$1')
        .substring(0, 500);

    return (
        <ModalRoot {...props}>
            <ModalHeader>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                    <div>
                        <div style={{ color: "var(--text-positive)", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "4px" }}>Update Available</div>
                        <span style={{ color: "#fff", fontSize: "20px", fontWeight: 600 }}>Server Cloner</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>v{PLUGIN_VERSION}</span>
                        <span style={{ color: "var(--text-muted)" }}>→</span>
                        <span style={{ background: "var(--text-positive)", color: "white", padding: "4px 10px", borderRadius: "12px", fontSize: "12px", fontWeight: 600 }}>v{version}</span>
                    </div>
                </div>
            </ModalHeader>
            <ModalContent>
                <div style={{ padding: "8px 0" }}>
                    <div style={{ background: "var(--background-secondary)", borderRadius: "12px", padding: "16px", maxHeight: "200px", overflowY: "auto" }}>
                        <div style={{ color: "var(--text-muted)", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "10px" }}>What's New</div>
                        <div style={{ fontSize: "13px", lineHeight: 1.6, color: "var(--text-normal)", whiteSpace: "pre-wrap" }}>{cleanNotes}</div>
                    </div>
                </div>
            </ModalContent>
            <ModalFooter>
                <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.PRIMARY} onClick={async () => {
                        await DataStore.set('ServerCloner-dismissed-version', version);
                        props.onClose();
                    }}>
                        Later
                    </Button>
                    <Button color={Button.Colors.GREEN} onClick={async () => {
                        window.open(GITHUB_RELEASE_URL, '_blank');
                        await DataStore.set('ServerCloner-dismissed-version', version);
                        props.onClose();
                    }}>
                        Update Now
                    </Button>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
};

function showUpdateModal(version: string, releaseNotes: string) {
    openModal((modalProps: ModalProps) => (
        <UpdateModal props={modalProps} version={version} releaseNotes={releaseNotes} />
    ));
}

function checkGuildExistence(sourceId: string, targetId: string) {
    if (!GuildStore.getGuild(sourceId)) throw new Error("Original server is gone");
    if (!GuildStore.getGuild(targetId)) throw new Error("Target server is gone");
}

interface CloneOptions {
    cloneChannels: boolean;
    cloneRoles: boolean;
    cloneOnboarding: boolean;
    cloneSystemFlags: boolean;
    resumeMode: boolean;
    targetGuildId: string | null;
}

const CloneModal = ({ props, guild, onClone }: { props: ModalProps; guild: Guild; onClone: (options: CloneOptions) => void; }) => {
    const [cloneChannels, setCloneChannels] = React.useState(true);
    const [cloneRoles, setCloneRoles] = React.useState(true);
    const [cloneOnboarding, setCloneOnboarding] = React.useState(true);
    const [cloneSystemFlags, setCloneSystemFlags] = React.useState(true);

    const [resumeMode, setResumeMode] = React.useState(false);
    const [targetGuildId, setTargetGuildId] = React.useState<string | null>(null);

    const canOnboarding = cloneChannels && cloneRoles;

    React.useEffect(() => {
        if (!canOnboarding) setCloneOnboarding(false);
    }, [canOnboarding]);

    const ownedGuilds = React.useMemo(() => {
        const allGuilds = Object.values(GuildStore.getGuilds()) as Guild[];
        return allGuilds.filter(g => g.id !== guild.id && g.ownerId === UserStore.getCurrentUser()?.id);
    }, [guild.id]);

    const nothingSelected = !cloneChannels && !cloneRoles && !cloneOnboarding && !cloneSystemFlags;

    const estimatedTime = React.useMemo(() => {
        const roleCount = cloneRoles ? (GuildRoleStore.getSortedRoles(guild.id) || []).filter((r: any) => r.name !== "@everyone").length : 0;
        const channelCount = cloneChannels ? extractChannels(guild.id, false).length : 0;
        const onboardingEstimate = cloneOnboarding ? 2 : 0;

        const perItemDelay = 1.5;
        const setupTime = 5;
        const deleteTime = (targetGuildId && !resumeMode) ? (channelCount * 1.2 + roleCount * 1.2) : 0;

        const totalSeconds = setupTime + deleteTime + (roleCount * perItemDelay) + (channelCount * perItemDelay) + (onboardingEstimate * perItemDelay);

        if (totalSeconds < 60) return `~${Math.ceil(totalSeconds)}s`;
        const mins = Math.floor(totalSeconds / 60);
        const secs = Math.ceil(totalSeconds % 60);
        return secs > 0 ? `~${mins}m ${secs}s` : `~${mins}m`;
    }, [guild.id, cloneRoles, cloneChannels, cloneOnboarding, targetGuildId, resumeMode]);

    const handleClone = () => {
        if (nothingSelected) return;
        if (targetGuildId && !resumeMode) {
            const targetName = ownedGuilds.find((g: Guild) => g.id === targetGuildId)?.name || "the target server";
            const deletingParts: string[] = [];
            if (cloneChannels) deletingParts.push("channels");
            if (cloneRoles) deletingParts.push("roles");
            const deletingText = deletingParts.join(", ");
            props.onClose();
            openModal((confirmProps: ModalProps) => (
                <ModalRoot {...confirmProps}>
                    <ModalHeader>
                        <span style={{ color: "#f04747", fontSize: "20px", fontWeight: 600 }}>⚠️ Confirm Overwrite</span>
                    </ModalHeader>
                    <ModalContent>
                        <div style={{ padding: "16px 0", fontSize: "14px", color: "#ffffff", lineHeight: 1.6 }}>
                            <p>This will <strong style={{ color: "#f04747" }}>permanently delete</strong> all {deletingText} in <strong>{targetName}</strong> and replace them with data from <strong>{guild.name}</strong>.</p>
                            <p style={{ marginTop: "12px", color: "#a0a3a6" }}>This action cannot be undone.</p>
                        </div>
                    </ModalContent>
                    <ModalFooter>
                        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                            <Button color={Button.Colors.PRIMARY} onClick={() => confirmProps.onClose()}>
                                Cancel
                            </Button>
                            <Button color={Button.Colors.RED} onClick={() => {
                                onClone({ cloneChannels, cloneRoles, cloneOnboarding, cloneSystemFlags, resumeMode: false, targetGuildId });
                                confirmProps.onClose();
                            }}>
                                Delete & Overwrite
                            </Button>
                        </div>
                    </ModalFooter>
                </ModalRoot>
            ));
        } else {
            onClone({ cloneChannels, cloneRoles, cloneOnboarding, cloneSystemFlags, resumeMode, targetGuildId });
            props.onClose();
        }
    };

    return (
        <ModalRoot {...props}>
            <ModalHeader>
                <span style={{ color: "#fff", fontSize: "20px", fontWeight: 600 }}>Clone Server: {guild.name}</span>
            </ModalHeader>
            <ModalContent>
                <div style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "8px 0", minHeight: "450px" }}>

                    <div>
                        <span style={{ color: "#fff", fontSize: "14px", fontWeight: 600, marginBottom: "8px", display: "block" }}>Clone To:</span>
                        <SearchableSelect
                            options={[
                                { value: "new", label: "Create New Server" },
                                ...ownedGuilds.map((g: Guild) => ({ value: g.id, label: g.name }))
                            ]}
                            value={{ value: targetGuildId || "new", label: targetGuildId ? ownedGuilds.find((g: Guild) => g.id === targetGuildId)?.name || "Server" : "Create New Server" }}
                            placeholder="Select destination..."
                            maxVisibleItems={5}
                            closeOnSelect={true}
                            onChange={(v: string) => {
                                setTargetGuildId(v === "new" ? null : v);
                                if (v === "new") setResumeMode(false);
                            }}
                        />
                        {targetGuildId && !resumeMode && (
                            <div style={{ fontSize: "12px", color: "#f04747", marginTop: "6px" }}>
                                ⚠️ Warning: Selected items in the target server will be deleted and replaced!
                            </div>
                        )}
                        {targetGuildId && resumeMode && (
                            <div style={{ fontSize: "12px", color: "#43b581", marginTop: "6px" }}>
                                ✓ Resume mode: Only missing items will be added, nothing will be deleted.
                            </div>
                        )}
                    </div>

                    {targetGuildId && (
                        <div style={{ display: "flex", gap: "8px" }}>
                            <button
                                onClick={() => setResumeMode(false)}
                                style={{
                                    flex: 1, padding: "10px", borderRadius: "8px", border: "2px solid",
                                    borderColor: !resumeMode ? "#5865f2" : "var(--background-modifier-accent)",
                                    background: !resumeMode ? "rgba(88,101,242,0.15)" : "var(--background-secondary)",
                                    color: !resumeMode ? "#5865f2" : "var(--text-muted)",
                                    cursor: "pointer", fontWeight: 600, fontSize: "13px", transition: "all 0.2s"
                                }}
                            >
                                Overwrite
                            </button>
                            <button
                                onClick={() => setResumeMode(true)}
                                style={{
                                    flex: 1, padding: "10px", borderRadius: "8px", border: "2px solid",
                                    borderColor: resumeMode ? "#43b581" : "var(--background-modifier-accent)",
                                    background: resumeMode ? "rgba(67,181,129,0.15)" : "var(--background-secondary)",
                                    color: resumeMode ? "#43b581" : "var(--text-muted)",
                                    cursor: "pointer", fontWeight: 600, fontSize: "13px", transition: "all 0.2s"
                                }}
                            >
                                Resume
                            </button>
                        </div>
                    )}

                    <div style={{ background: "var(--background-secondary)", padding: "12px", borderRadius: "8px", fontSize: "13px", color: "#dbdee1" }}>
                        <strong style={{ color: "#fff" }}>Note:</strong> Server Icon, Name, Banner, Splash, Description{cloneSystemFlags ? ", and System Channel Flags" : ""} will always be cloned.
                    </div>

                    <div>
                        <span style={{ color: "#fff", fontSize: "14px", fontWeight: 600, marginBottom: "8px", display: "block" }}>Core:</span>
                        <Checkbox
                            value={cloneChannels}
                            type="inverted"
                            onChange={(_: any, val: boolean) => setCloneChannels(val)}
                        >
                            <span style={{ color: "#fff", fontWeight: 500 }}>Channels</span>
                            <span style={{ fontSize: "12px", color: "#b5bac1", display: "block", marginTop: "2px" }}>
                                All channel types with topics, positions, and settings
                            </span>
                        </Checkbox>

                        <Checkbox
                            value={cloneRoles}
                            type="inverted"
                            onChange={(_: any, val: boolean) => setCloneRoles(val)}
                        >
                            <span style={{ color: "#fff", fontWeight: 500 }}>Roles</span>
                            <span style={{ fontSize: "12px", color: "#b5bac1", display: "block", marginTop: "2px" }}>
                                With permissions, colors, and icons
                            </span>
                        </Checkbox>
                    </div>

                    <div>
                        <span style={{ color: "#fff", fontSize: "14px", fontWeight: 600, marginBottom: "8px", display: "block" }}>Server Settings:</span>

                        <Checkbox
                            value={cloneOnboarding}
                            type="inverted"
                            onChange={(_: any, val: boolean) => setCloneOnboarding(val)}
                            disabled={!canOnboarding}
                        >
                            <span style={{ color: canOnboarding ? "#fff" : "#72767d", fontWeight: 500 }}>Onboarding</span>
                            <span style={{ fontSize: "12px", color: canOnboarding ? "#b5bac1" : "#72767d", display: "block", marginTop: "2px" }}>
                                {canOnboarding ? "Welcome prompts, default channels, and customization" : "⚠️ Requires both Channels and Roles"}
                            </span>
                        </Checkbox>

                        <Checkbox
                            value={cloneSystemFlags}
                            type="inverted"
                            onChange={(_: any, val: boolean) => setCloneSystemFlags(val)}
                        >
                            <span style={{ color: "#fff", fontWeight: 500 }}>System Channel Flags</span>
                            <span style={{ fontSize: "12px", color: "#b5bac1", display: "block", marginTop: "2px" }}>
                                Join/boost notification toggles
                            </span>
                        </Checkbox>
                    </div>

                    {(() => {
                        const sourceTier = (guild as any).premiumTier || 0;
                        const boostFeatures: string[] = [];
                        if ((guild as any).banner) boostFeatures.push("Server Banner (Level 2)");
                        if ((guild as any).splash) boostFeatures.push("Invite Splash (Level 2)");
                        const roles = GuildRoleStore.getSortedRoles(guild.id) || [];
                        if (roles.some((r: any) => r.icon)) boostFeatures.push("Role Icons (Level 2)");
                        if (sourceTier >= 1) boostFeatures.push("High Bitrate Voice (Level 1+)");

                        if (boostFeatures.length === 0) return null;

                        const targetGuild = targetGuildId ? GuildStore.getGuild(targetGuildId) : null;
                        const targetTier = targetGuild ? (targetGuild as any).premiumTier || 0 : 0;
                        const isNewServer = !targetGuildId;

                        if (!isNewServer && targetTier >= sourceTier) return null;

                        return (
                            <div style={{ background: "rgba(250,166,26,0.1)", border: "1px solid rgba(250,166,26,0.3)", padding: "12px", borderRadius: "8px", fontSize: "12px", color: "#faa61a" }}>
                                <strong style={{ display: "block", marginBottom: "6px" }}>⚡ Boost-Dependent Features:</strong>
                                <div style={{ color: "#dbdee1", lineHeight: 1.7 }}>
                                    {boostFeatures.map((f, i) => (
                                        <div key={i}>• {f}</div>
                                    ))}
                                </div>
                                <div style={{ marginTop: "8px", color: "#faa61a", fontStyle: "italic" }}>
                                    {isNewServer
                                        ? "⚠️ New servers have no boosts — these features will be skipped."
                                        : `⚠️ Target server is Level ${targetTier}, source is Level ${sourceTier} — some features may fail.`
                                    }
                                </div>
                            </div>
                        );
                    })()}

                </div>
            </ModalContent>
            <ModalFooter>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%" }}>
                    {!nothingSelected && (
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", background: "rgba(88,101,242,0.1)", borderRadius: "8px", fontSize: "13px", color: "#b5bac1" }}>
                            <span style={{ fontSize: "16px" }}>⏱️</span>
                            <span>Estimated time: <strong style={{ color: "#fff" }}>{estimatedTime}</strong></span>
                        </div>
                    )}
                    <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                        <Button color={Button.Colors.PRIMARY} onClick={() => props.onClose()}>
                            Cancel
                        </Button>
                        <Button color={Button.Colors.BRAND} onClick={handleClone} disabled={nothingSelected}>
                            {targetGuildId ? (resumeMode ? "Resume Clone" : "Overwrite & Clone") : "Create & Clone"}
                        </Button>
                    </div>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
};

let emojiIdMap: Record<string, string> = {};
const replaceEmojis = (text: string | null | undefined): string | null | undefined => {
    if (!text) return text;
    return text.replace(/<(a?):([a-zA-Z0-9_]+):(\d+)>/g, (match, animated, name, id) => {
        if (emojiIdMap[id]) return `<${animated}:${name}:${emojiIdMap[id]}>`;
        return match;
    });
};

async function cloneServer(sourceGuild: Guild, options: CloneOptions) {
    if (isCloning) {
        notify("Already Cloning", "Please wait for the current clone to finish", "error");
        return;
    }

    isCloning = true;
    emojiIdMap = {};

    let rolesFailed = 0;
    let channelsFailed = 0;

    let skipRoles = false;

    const roleRateLimiter = new RateLimiter(settings.store.channelDelay);
    const channelRateLimiter = new RateLimiter(settings.store.channelDelay);

    try {
        const guild = GuildStore.getGuild(sourceGuild.id);
        if (!guild) throw new Error("Server not found");

        const fullGuildData = await fetchGuildData(sourceGuild.id);
        const estimateChannels = options.cloneChannels ? await RestAPI.get({ url: `/guilds/${sourceGuild.id}/channels` }).then(r => r.body || []) : [];
        const estimateRoles = options.cloneRoles ? await fetchGuildRoles(sourceGuild.id) : [];
        let channelCount = estimateChannels.length;
        let roleCount = estimateRoles.length - 1;
        const delayMs = settings.store.channelDelay;

        if (options.targetGuildId && options.resumeMode) {
            try {
                const [targetRoles, targetChResp] = await Promise.all([
                    fetchGuildRoles(options.targetGuildId),
                    RestAPI.get({ url: `/guilds/${options.targetGuildId}/channels` })
                ]);
                const targetChannels = (targetChResp as any).body || [];

                const matchingRoles = estimateRoles.filter(sr =>
                    targetRoles.some((tr: any) => tr.name === sr.name && tr.color === sr.color)
                ).length;

                const matchingChannels = estimateChannels.filter(sc =>
                    targetChannels.some((tc: any) => tc.name === sc.name && tc.type === sc.type)
                ).length;

                roleCount = Math.max(0, roleCount - matchingRoles);
                channelCount = Math.max(0, channelCount - matchingChannels);
            } catch (e) {
                console.warn("[ServerCloner] Failed to pre-fetch target guild for estimates", e);
            }
        }

        let apiCalls = 0;
        let sleepSeconds = 0;

        apiCalls += 4;

        if (options.targetGuildId) {
            if (!options.resumeMode) {
                const targetCh = extractChannels(options.targetGuildId, false);
                const targetRoles = await fetchGuildRoles(options.targetGuildId);
                if (options.cloneChannels) apiCalls += targetCh.length + 1;
                if (options.cloneRoles) apiCalls += targetRoles.filter((r: any) => r.name !== "@everyone").length;
                sleepSeconds += 6;
            }
            apiCalls += 1;
        } else {
            apiCalls += 1;
            sleepSeconds += 5;
            apiCalls += 3;
        }

        if (options.cloneRoles) {
            apiCalls += 2;
            apiCalls += roleCount;
        }

        if (options.cloneChannels) {
            apiCalls += 1;
            apiCalls += channelCount;
            const isCommunity = fullGuildData?.features?.includes("COMMUNITY") || estimateChannels.some((c: any) => [5, 13, 15, 16].includes(c.type));
            if (isCommunity && !options.resumeMode) {
                apiCalls += 4;
                sleepSeconds += 2;
            }
            apiCalls += 1;
            apiCalls += Math.ceil(channelCount / 50);
        }

        if (options.cloneOnboarding) {
            apiCalls += 2;
        }

        apiCalls += 1;

        const avgDelaySeconds = (delayMs * 1.25) / 1000;
        let estimatedSeconds = Math.ceil((apiCalls * avgDelaySeconds) + sleepSeconds);
        estimatedSeconds = Math.max(10, estimatedSeconds);

        const formatTime = (s: number) => {
            const time = Math.max(0, Math.floor(s));
            const m = Math.floor(time / 60);
            const rs = time % 60;
            return `${m}:${rs.toString().padStart(2, '0')}`;
        };

        const timeStr = formatTime(estimatedSeconds);

        const initialMsg = options.targetGuildId
            ? `Starting... (Est. ${timeStr})`
            : `Starting... (Est. ${timeStr})\nYou'll be navigated to the new server when cloning is complete.`;

        mainProgressNotificationId = createMainProgressNotification(
            `Cloning "${guild.name}"`,
            initialMsg,
            () => { skipRoles = true; },
            options.targetGuildId !== null,
            options.cloneRoles && options.cloneChannels
        );

        const hasRoles = options.cloneRoles;
        const hasChannels = options.cloneChannels;
        const hasOnboarding = options.cloneOnboarding;

        let totalWeight = 0;
        if (hasRoles) totalWeight += 30;
        if (hasChannels) totalWeight += 50;
        totalWeight += 5;
        if (hasOnboarding) totalWeight += 5;

        const scale = totalWeight > 0 ? (90 / totalWeight) : 1;
        let currentProgress = 5;

        const advanceProgress = (weight: number) => {
            const start = currentProgress;
            currentProgress += weight * scale;
            return { start, end: currentProgress };
        };

        const rolesProgress = advanceProgress(hasRoles ? 30 : 0);
        const channelsProgress = advanceProgress(hasChannels ? 50 : 0);
        const settingsProgress = advanceProgress(5);
        const onboardingProgress = advanceProgress(hasOnboarding ? 5 : 0);

        const rolesProgressStart = rolesProgress.start;
        const rolesProgressEnd = rolesProgress.end;
        const channelsProgressStart = channelsProgress.start;
        const channelsProgressEnd = channelsProgress.end;

        // Time live counting has been removed per user feedback. Estimate strictly shown in modal.

        const updateWithTime = (msg: string, percent: number) => {
            if (!mainProgressNotificationId) return;
            const notification = document.getElementById(mainProgressNotificationId);
            if (notification) {
                const bodyEl = notification.querySelector(".cloner-notification-body");
                if (bodyEl) bodyEl.textContent = msg;

                updateMainProgress(mainProgressNotificationId, msg, percent);
            }
        };

        updateWithTime(`Preparing server data...`, 5);

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
                            iconBase64 = `data:image/png;base64,${arrayBufferToBase64(iconData)}`;
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
                            bannerBase64 = `data:image/png;base64,${arrayBufferToBase64(bannerData)}`;
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
                            splashBase64 = `data:image/png;base64,${arrayBufferToBase64(splashData)}`;
                        }
                    } catch (e) {
                        console.warn("[ServerCloner] Failed to fetch splash:", e);
                    }
                }
            })()
        ]);

        if (!isCloning) throw new Error("Cancelled");

        let newGuildId: string;

        if (options.targetGuildId) {
            newGuildId = options.targetGuildId;
            currentCloneGuildId = newGuildId;

            updateWithTime(`Preparing target server...`, 10);

            if (!options.resumeMode) {
                const overwriteLimiter = new RateLimiter(1000);

                if (options.cloneChannels) {
                    try {
                        await RestAPI.patch({
                            url: `/guilds/${newGuildId}`,
                            body: {
                                features: [],
                                system_channel_id: null,
                                rules_channel_id: null,
                                public_updates_channel_id: null,
                                safety_alerts_channel_id: null,
                            }
                        });
                        await sleep(1000);
                    } catch (e) {
                        console.warn("[ServerCloner] Failed to disable community mode:", e);
                    }

                    const existingChannels = extractChannels(newGuildId, false).filter(c => c && c.id && typeof c.id === "string" && c.id !== "null");
                    let deletedCount = 0;
                    for (const channel of existingChannels) {
                        if (!isCloning) break;
                        deletedCount++;
                        updateWithTime(`Deleting channel ${deletedCount}/${existingChannels.length}: ${channel.name}`, 10);

                        try {
                            await overwriteLimiter.execute(
                                () => RestAPI.del({ url: `/channels/${channel.id}` }),
                                msg => updateWithTime(`Deleting channel: ${channel.name} (${msg})`, 10),
                                () => !isCloning
                            );
                        } catch (e: any) {
                            if (e?.message === "Cancelled") break;
                            console.warn("[ServerCloner] Failed to delete channel:", channel.id, e);
                        }
                    }
                }

                if (options.cloneRoles) {
                    const existingRoles = await fetchGuildRoles(newGuildId);
                    const deletableRoles = existingRoles.filter((r: any) => r.name !== "@everyone");
                    let deletedRoles = 0;
                    for (const role of existingRoles) {
                        if (!isCloning) break;
                        if (role.name === "@everyone") continue;
                        deletedRoles++;
                        updateWithTime(`Deleting role ${deletedRoles}/${deletableRoles.length}: ${role.name}`, 10);

                        try {
                            await overwriteLimiter.execute(
                                () => RestAPI.del({ url: `/guilds/${newGuildId}/roles/${role.id}` }),
                                msg => updateWithTime(`Deleting role: ${role.name} (${msg})`, 10),
                                () => !isCloning
                            );
                        } catch (e: any) {
                            if (e?.message === "Cancelled") break;
                            console.warn("[ServerCloner] Failed to delete role:", e);
                        }
                    }
                }

                updateWithTime(`Waiting for Discord to process deletions...`, 10);
                await sleep(5000);
            }

            const updatePayload: any = {
                name: guild.name + " (Clone)",
                description: replaceEmojis((guild as any).description),
                verification_level: (guild as any).verificationLevel ?? 0,
                default_message_notifications: (guild as any).defaultMessageNotifications ?? 0,
                explicit_content_filter: (guild as any).explicitContentFilter ?? 0,
                afk_timeout: (guild as any).afkTimeout ?? 300,
                preferred_locale: (guild as any).preferredLocale ?? "en-US",
                system_channel_flags: options.cloneSystemFlags ? ((guild as any).systemChannelFlags ?? 0) : 0,
            };
            if (iconBase64) updatePayload.icon = iconBase64;
            if (bannerBase64) updatePayload.banner = bannerBase64;
            if (splashBase64) updatePayload.splash = splashBase64;

            await RestAPI.patch({ url: `/guilds/${newGuildId}`, body: updatePayload });

        } else {
            const createPayload: any = {
                name: guild.name + " (Clone)",
                verification_level: (guild as any).verificationLevel ?? 0,
                default_message_notifications: (guild as any).defaultMessageNotifications ?? 0,
                explicit_content_filter: (guild as any).explicitContentFilter ?? 0,
                afk_timeout: (guild as any).afkTimeout ?? 300,
                preferred_locale: (guild as any).preferredLocale ?? "en-US",
                system_channel_flags: options.cloneSystemFlags ? ((guild as any).systemChannelFlags ?? 0) : 0,
            };

            if (iconBase64) createPayload.icon = iconBase64;

            const createResponse = await RestAPI.post({ url: "/guilds", body: createPayload });
            if (!createResponse?.body?.id) throw new Error("Failed to create guild");

            newGuildId = createResponse.body.id;
            currentCloneGuildId = newGuildId;

            await sleep(5000);

            const defaultChannels = extractChannels(newGuildId, false).filter(c => c && c.id && c.id !== "null" && (c.type === 0 || c.type === 2 || c.type === 4));
            for (const channel of defaultChannels) {
                try {
                    await RestAPI.del({ url: `/channels/${channel.id}` });
                    await sleep(500);
                } catch (e) {
                    console.warn("[ServerCloner] Failed to delete default channel:", e);
                }
            }
        }

        updateWithTime(`Extracting used emojis...`, 15);

        if (options.cloneEmojis || options.cloneOnboarding) {
            const customEmojiIds = new Set<string>();
            const addEmojisFromText = (text: string | null | undefined) => {
                if (!text) return;
                const matches = text.matchAll(/<a?:[a-zA-Z0-9_]+:(\d+)>/g);
                for (const match of matches) {
                    customEmojiIds.add(match[1]);
                }
            };

            // Scan Description
            addEmojisFromText(fullGuildData.description);

            // Scan Roles
            if (options.cloneRoles) {
                for (const role of estimateRoles) {
                    addEmojisFromText(role.name);
                }
            }

            // Scan Channels
            if (options.cloneChannels) {
                for (const ch of estimateChannels) {
                    addEmojisFromText(ch.name);
                    addEmojisFromText(ch.topic);
                    if (ch.available_tags) {
                        for (const tag of ch.available_tags) {
                            addEmojisFromText(tag.name);
                            if (tag.emoji_id) customEmojiIds.add(tag.emoji_id);
                        }
                    }
                    if (ch.default_reaction_emoji?.emoji_id) {
                        customEmojiIds.add(ch.default_reaction_emoji.emoji_id);
                    }
                }
            }

            // Scan Onboarding
            let onboardingData: any = null;
            if (options.cloneOnboarding) {
                try {
                    const onboardingResp = await RestAPI.get({ url: `/guilds/${sourceGuild.id}/onboarding` });
                    onboardingData = (onboardingResp as any).body;
                    if (onboardingData) {
                        for (const prompt of (onboardingData.prompts || [])) {
                            addEmojisFromText(prompt.title);
                            for (const opt of (prompt.options || [])) {
                                addEmojisFromText(opt.title);
                                addEmojisFromText(opt.description);
                                const eid = opt.emoji_id || opt.emoji?.id || null;
                                if (eid) customEmojiIds.add(eid);
                            }
                        }
                    }
                } catch (e) { }
            }

            if (customEmojiIds.size > 0) {
                if (mainProgressNotificationId) updateWithTime(`Cloning ${customEmojiIds.size} used emojis...`, 20);

                try {
                    const sourceEmojisResp = await RestAPI.get({ url: `/guilds/${sourceGuild.id}/emojis` });
                    const sourceEmojis = (sourceEmojisResp as any).body || [];
                    const emojisToClone = sourceEmojis.filter((e: any) => customEmojiIds.has(e.id));

                    let targetEmojis: any[] = [];
                    if (options.resumeMode && newGuildId) {
                        try {
                            const targetEmojisResp = await RestAPI.get({ url: `/guilds/${newGuildId}/emojis` });
                            targetEmojis = (targetEmojisResp as any).body || [];
                        } catch (e) {
                            console.warn("[ServerCloner] Failed to fetch target emojis for resume mode:", e);
                        }
                    }

                    let emojiStep = 0;
                    for (const emoji of emojisToClone) {
                        if (!isCloning) break;
                        emojiStep++;

                        if (options.resumeMode) {
                            const existing = targetEmojis.find(e => e.name === emoji.name);
                            if (existing) {
                                emojiIdMap[emoji.id] = existing.id;
                                if (mainProgressNotificationId) {
                                    updateWithTime(`Skipping existing emoji (${emojiStep}/${emojisToClone.length})...`, 20 + (emojiStep / emojisToClone.length) * 5);
                                }
                                continue;
                            }
                        }

                        if (mainProgressNotificationId) {
                            updateWithTime(`Cloning used emojis (${emojiStep}/${emojisToClone.length})...`, 20 + (emojiStep / emojisToClone.length) * 5);
                        }

                        try {
                            const ext = emoji.animated ? "gif" : "png";
                            const emojiUrl = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}?size=256`;
                            const response = await fetch(emojiUrl);
                            if (response.ok) {
                                const buffer = await response.arrayBuffer();
                                const base64 = typeof window !== "undefined"
                                    ? btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''))
                                    : Buffer.from(buffer).toString('base64');
                                const imageStr = `data:image/${ext};base64,${base64}`;

                                const createResp = await RestAPI.post({
                                    url: `/guilds/${newGuildId}/emojis`,
                                    body: {
                                        name: emoji.name,
                                        image: imageStr,
                                        roles: []
                                    }
                                });
                                if (createResp?.body?.id) {
                                    emojiIdMap[emoji.id] = createResp.body.id;
                                    await sleep(1500);
                                }
                            }
                        } catch (e) {
                            console.warn(`[ServerCloner] Failed to clone emoji ${emoji.name}:`, e);
                        }
                    }
                } catch (e) {
                    console.warn("[ServerCloner] Failed to fetch source emojis for extraction:", e);
                }
            }
        }

        updateWithTime(`Cloning content...`, rolesProgressStart);

        let roleIdMap: Record<string, string> = {};

        if (options.cloneRoles) {
            if (mainProgressNotificationId) {
                const skipBtn = document.getElementById(mainProgressNotificationId)?.querySelector(".cloner-skip-roles-btn") as HTMLElement;
                if (skipBtn) skipBtn.style.display = "";
            }
            const roles = estimateRoles;
            const sortedRoles = roles.filter(r => r.name !== "@everyone").sort((a, b) => a.position - b.position);

            const everyoneRole = roles.find(r => r.name === "@everyone");

            const newRoles = await RestAPI.get({ url: `/guilds/${newGuildId}/roles` });
            const existingTargetRoles = newRoles.body || [];
            const newEveryoneRole = existingTargetRoles.find((r: any) => r.name === "@everyone");

            if (everyoneRole && newEveryoneRole) {
                roleIdMap[everyoneRole.id] = newEveryoneRole.id;
                try {
                    await RestAPI.patch({
                        url: `/guilds/${newGuildId}/roles/${newEveryoneRole.id}`,
                        body: {
                            permissions: everyoneRole.permissions.toString()
                        }
                    });
                } catch (e) {
                    console.warn("[ServerCloner] Failed to update @everyone role:", e);
                }
            }

            if (options.resumeMode) {
                for (const role of sortedRoles) {
                    const match = existingTargetRoles.find((r: any) => r.name === role.name && r.name !== "@everyone");
                    if (match) {
                        roleIdMap[role.id] = match.id;

                        const expectedName = replaceEmojis(role.name) || role.name;
                        if (match.name !== expectedName) {
                            try {
                                await RestAPI.patch({
                                    url: `/guilds/${newGuildId}/roles/${match.id}`,
                                    body: { name: expectedName }
                                });
                            } catch (e) {
                                console.warn(`[ServerCloner] Failed to patch existing role emoji: ${role.name}`, e);
                            }
                        }
                    }
                }
            }

            const rolesToCreate = options.resumeMode
                ? sortedRoles.filter(r => !roleIdMap[r.id])
                : sortedRoles;

            const actionLabel = options.resumeMode ? "Resuming" : "Cloning";

            const targetGuildForTier = GuildStore.getGuild(newGuildId);
            const targetTier = (targetGuildForTier as any)?.premiumTier || 0;
            const canUseRoleIcons = targetTier >= 2;

            let roleStep = 0;
            for (const role of rolesToCreate) {
                if (!isCloning) break;
                if (skipRoles) {
                    if (mainProgressNotificationId) updateWithTime(`Skipping roles...`, rolesProgressEnd);
                    break;
                }

                try {
                    checkGuildExistence(sourceGuild.id, newGuildId);
                    roleStep++;
                    if (mainProgressNotificationId) {
                        updateWithTime(`${actionLabel} role ${roleStep}/${rolesToCreate.length}: ${role.name}`, rolesProgressStart + ((roleStep / Math.max(rolesToCreate.length, 1)) * (rolesProgressEnd - rolesProgressStart)));
                    }

                    const rolePayload: any = {
                        name: replaceEmojis(role.name),
                        permissions: role.permissions.toString(),
                        color: role.color,
                        hoist: role.hoist,
                        mentionable: role.mentionable,
                    };

                    if (canUseRoleIcons) {
                        rolePayload.unicode_emoji = (role as any).unicodeEmoji || (role as any).unicode_emoji || null;

                        const roleIcon = (role as any).icon;
                        if (roleIcon) {
                            try {
                                const iconUrl = `https://cdn.discordapp.com/role-icons/${role.id}/${roleIcon}.png?size=128`;
                                const iconResp = await fetch(iconUrl);
                                if (iconResp.ok) {
                                    const iconBuf = await iconResp.arrayBuffer();
                                    rolePayload.icon = `data:image/png;base64,${arrayBufferToBase64(iconBuf)}`;
                                }
                            } catch (_) { }
                        }
                    }

                    const response = await roleRateLimiter.execute(async () => {
                        try {
                            return await RestAPI.post({
                                url: `/guilds/${newGuildId}/roles`,
                                body: rolePayload
                            });
                        } catch (e: any) {
                            let code = e?.body?.code || e?.code;
                            if (!code && e?.text) {
                                try { code = JSON.parse(e.text)?.code; } catch (_) { }
                            }

                            if (code === 50101) {
                                delete rolePayload.icon;
                                delete rolePayload.unicode_emoji;
                                return await RestAPI.post({
                                    url: `/guilds/${newGuildId}/roles`,
                                    body: rolePayload
                                });
                            }
                            throw e;
                        }
                    }, undefined, () => skipRoles, 5);

                    if (response?.body?.id) {
                        roleIdMap[role.id] = response.body.id;
                    }
                } catch (e: any) {
                    if (e?.rateLimitExhausted) {
                        console.warn("[ServerCloner] Too many rate limits on roles, skipping remaining roles.");
                        rolesFailed += (rolesToCreate.length - roleStep);
                        if (mainProgressNotificationId) updateWithTime(`Rate limited, skipping remaining roles...`, rolesProgressEnd);
                        break;
                    }
                    rolesFailed++;
                }
            }

            if (options.resumeMode && rolesToCreate.length === 0) {
                if (mainProgressNotificationId) updateWithTime(`All roles already exist, skipping...`, rolesProgressEnd);
            }
        }

        if (mainProgressNotificationId) {
            const skipBtn = document.getElementById(mainProgressNotificationId)?.querySelector(".cloner-skip-roles-btn") as HTMLElement;
            if (skipBtn) skipBtn.style.display = "none";
            updateWithTime(`Starting channels...`, channelsProgressStart);
        }

        if (options.cloneChannels) {
            const allChannels = estimateChannels;

            const categories = allChannels.filter((c: any) => c.type === 4).sort((a: any, b: any) => a.position - b.position);
            const otherChannels = allChannels.filter((c: any) => c.type !== 4).sort((a: any, b: any) => a.position - b.position);
            console.log(`[ServerCloner] Found ${categories.length} categories and ${otherChannels.length} channels from source`);

            const channelIdMap: Record<string, string> = {};

            let existingTargetChannels: any[] = [];
            if (options.resumeMode) {
                const targetChResponse = await RestAPI.get({ url: `/guilds/${newGuildId}/channels` });
                existingTargetChannels = targetChResponse.body || [];

                for (const cat of categories) {
                    const match = existingTargetChannels.find((tc: any) => tc.name === cat.name && tc.type === 4);
                    if (match) channelIdMap[cat.id] = match.id;
                }
                for (const ch of otherChannels) {
                    const match = existingTargetChannels.find((tc: any) => tc.name === ch.name && tc.type === ch.type);
                    if (match) channelIdMap[ch.id] = match.id;
                }
            }

            const categoriesToCreate = options.resumeMode ? categories.filter((c: any) => !channelIdMap[c.id]) : categories;
            const channelsToCreate = options.resumeMode ? otherChannels.filter((c: any) => !channelIdMap[c.id]) : otherChannels;
            const totalChannels = categoriesToCreate.length + channelsToCreate.length;
            const actionLabel = options.resumeMode ? "Resuming" : "Cloning";

            if (mainProgressNotificationId) {
                if (options.resumeMode && totalChannels === 0) {
                    updateWithTime(`All channels already exist, skipping...`, channelsProgressEnd);
                } else {
                    updateWithTime(`${actionLabel} ${totalChannels} channels...`, channelsProgressStart);
                }
            }

            let catStored = 0;
            for (const cat of categoriesToCreate) {
                checkGuildExistence(sourceGuild.id, newGuildId);
                if (!isCloning) break;
                catStored++;

                try {
                    const progress = channelsProgressStart + ((catStored / Math.max(categoriesToCreate.length, 1)) * ((channelsProgressEnd - channelsProgressStart) * 0.2));
                    if (mainProgressNotificationId) {
                        updateWithTime(`${actionLabel} category ${catStored}/${categoriesToCreate.length}: ${cat.name}`, progress);
                    }

                    const catPayload: any = {
                        name: cat.name,
                        type: 4,
                        position: cat.position,
                        permission_overwrites: []
                    };

                    if (cat.permission_overwrites) {
                        const mappedOverwrites = cat.permission_overwrites
                            .filter((ow: any) => ow.type === 0 && roleIdMap[ow.id])
                            .map((ow: any) => ({
                                id: roleIdMap[ow.id],
                                type: 0,
                                allow: ow.allow,
                                deny: ow.deny
                            }));
                        if (mappedOverwrites.length > 0) catPayload.permission_overwrites = mappedOverwrites;
                    }

                    const response = await channelRateLimiter.execute(async () => {
                        return await RestAPI.post({ url: `/guilds/${newGuildId}/channels`, body: catPayload });
                    });

                    if (response?.body?.id) {
                        channelIdMap[cat.id] = response.body.id;
                    }
                } catch (e) {
                    channelsFailed++;
                    console.warn("[ServerCloner] Failed to clone category:", cat.name, e);
                }
            }

            const isCommunity = fullGuildData.features?.includes("COMMUNITY") ||
                otherChannels.some((c: any) => [5, 13, 15, 16].includes(c.type));

            if (isCommunity && !options.resumeMode) {
                if (mainProgressNotificationId) {
                    updateWithTime("Enabling Community features...", channelsProgressStart + ((channelsProgressEnd - channelsProgressStart) * 0.25));
                }
                try {
                    let rulesChannelNewId: string | null = null;
                    let updatesChannelNewId: string | null = null;

                    const sourceRulesChannel = fullGuildData.rules_channel_id
                        ? otherChannels.find((c: any) => c.id === fullGuildData.rules_channel_id)
                        : null;
                    const sourceUpdatesChannel = fullGuildData.public_updates_channel_id
                        ? otherChannels.find((c: any) => c.id === fullGuildData.public_updates_channel_id)
                        : null;

                    if (sourceRulesChannel) {
                        const rulesPayload: any = {
                            name: sourceRulesChannel.name,
                            type: sourceRulesChannel.type || 0,
                            topic: sourceRulesChannel.topic || undefined,
                            position: sourceRulesChannel.position,
                        };
                        if (sourceRulesChannel.parent_id && channelIdMap[sourceRulesChannel.parent_id]) {
                            rulesPayload.parent_id = channelIdMap[sourceRulesChannel.parent_id];
                        }
                        const r1 = await channelRateLimiter.execute(() => RestAPI.post({ url: `/guilds/${newGuildId}/channels`, body: rulesPayload }));
                        if (r1?.body?.id) {
                            rulesChannelNewId = r1.body.id;
                            channelIdMap[sourceRulesChannel.id] = r1.body.id;
                        }
                    }

                    if (sourceUpdatesChannel) {
                        const updatesPayload: any = {
                            name: sourceUpdatesChannel.name,
                            type: sourceUpdatesChannel.type || 0,
                            topic: sourceUpdatesChannel.topic || undefined,
                            position: sourceUpdatesChannel.position,
                        };
                        if (sourceUpdatesChannel.parent_id && channelIdMap[sourceUpdatesChannel.parent_id]) {
                            updatesPayload.parent_id = channelIdMap[sourceUpdatesChannel.parent_id];
                        }
                        const r2 = await channelRateLimiter.execute(() => RestAPI.post({ url: `/guilds/${newGuildId}/channels`, body: updatesPayload }));
                        if (r2?.body?.id) {
                            updatesChannelNewId = r2.body.id;
                            channelIdMap[sourceUpdatesChannel.id] = r2.body.id;
                        }
                    }

                    if (!rulesChannelNewId) {
                        const fallback = await channelRateLimiter.execute(() => RestAPI.post({ url: `/guilds/${newGuildId}/channels`, body: { name: "rules", type: 0 } }));
                        rulesChannelNewId = fallback?.body?.id || null;
                    }
                    if (!updatesChannelNewId) {
                        const fallback = await channelRateLimiter.execute(() => RestAPI.post({ url: `/guilds/${newGuildId}/channels`, body: { name: "updates", type: 0 } }));
                        updatesChannelNewId = fallback?.body?.id || null;
                    }

                    if (rulesChannelNewId && updatesChannelNewId) {
                        await RestAPI.patch({
                            url: `/guilds/${newGuildId}`,
                            body: {
                                features: ["COMMUNITY"],
                                rules_channel_id: rulesChannelNewId,
                                public_updates_channel_id: updatesChannelNewId,
                                verification_level: 1,
                                explicit_content_filter: 2
                            }
                        });
                        await new Promise(r => setTimeout(r, 1500));
                    }
                } catch (e) {
                    console.warn("[ServerCloner] Failed to enable community:", e);
                }
            }

            const alreadyCloned = new Set(Object.keys(channelIdMap));

            if (options.resumeMode) {
                const skippedChannels = otherChannels.filter((c: any) => alreadyCloned.has(c.id));
                for (const ch of skippedChannels) {
                    const matchId = channelIdMap[ch.id];
                    if (!matchId) continue;

                    const match = existingTargetChannels.find((tc: any) => tc.id === matchId);
                    if (match) {
                        const expectedName = replaceEmojis(ch.name) || ch.name;
                        const expectedTopic = replaceEmojis(ch.topic) || ch.topic;

                        if (match.name !== expectedName || match.topic !== expectedTopic) {
                            try {
                                const patchBody: any = {};
                                if (match.name !== expectedName) patchBody.name = expectedName;
                                if (match.topic !== expectedTopic) patchBody.topic = expectedTopic;

                                await RestAPI.patch({
                                    url: `/guilds/${newGuildId}/channels/${match.id}`,
                                    body: patchBody
                                });
                            } catch (e) {
                                console.warn(`[ServerCloner] Failed to patch existing channel emoji: ${ch.name}`, e);
                            }
                        }
                    }
                }
            }

            const remainingChannels = channelsToCreate.filter((c: any) => !alreadyCloned.has(c.id));

            let chStored = 0;
            for (const ch of remainingChannels) {
                checkGuildExistence(sourceGuild.id, newGuildId);
                if (!isCloning) break;
                chStored++;

                try {
                    const progress = channelsProgressStart + ((channelsProgressEnd - channelsProgressStart) * 0.2) + ((chStored / Math.max(remainingChannels.length, 1)) * ((channelsProgressEnd - channelsProgressStart) * 0.8));
                    if (mainProgressNotificationId) {
                        updateWithTime(`${actionLabel} channel ${chStored}/${remainingChannels.length}: ${ch.name}`, progress);
                    }

                    const chPayload: any = {
                        name: replaceEmojis(ch.name),
                        type: ch.type,
                        position: ch.position,
                        topic: replaceEmojis(ch.topic),
                        nsfw: ch.nsfw,
                        rate_limit_per_user: ch.rate_limit_per_user,
                        permission_overwrites: []
                    };

                    if (ch.parent_id && channelIdMap[ch.parent_id]) {
                        chPayload.parent_id = channelIdMap[ch.parent_id];
                    }

                    if (ch.type === 2 || ch.type === 13) {
                        chPayload.bitrate = Math.min(ch.bitrate || 64000, 96000);
                        chPayload.user_limit = ch.user_limit || 0;
                    }

                    if (ch.type === 15 || ch.type === 16) {
                        if (ch.available_tags && Array.isArray(ch.available_tags)) {
                            chPayload.available_tags = ch.available_tags.map((tag: any) => ({
                                name: replaceEmojis(tag.name),
                                emoji_id: tag.emoji_id && emojiIdMap[tag.emoji_id] ? emojiIdMap[tag.emoji_id] : null,
                                emoji_name: tag.emoji_name || null,
                                moderated: tag.moderated || false
                            }));
                        }
                        if (ch.default_reaction_emoji) {
                            if (ch.default_reaction_emoji.emoji_id && emojiIdMap[ch.default_reaction_emoji.emoji_id]) {
                                chPayload.default_reaction_emoji = {
                                    emoji_id: emojiIdMap[ch.default_reaction_emoji.emoji_id],
                                    emoji_name: ch.default_reaction_emoji.emoji_name || null
                                };
                            } else if (ch.default_reaction_emoji.emoji_name && !ch.default_reaction_emoji.emoji_id) {
                                chPayload.default_reaction_emoji = {
                                    emoji_id: null,
                                    emoji_name: ch.default_reaction_emoji.emoji_name
                                };
                            }
                        }
                        if (ch.default_sort_order !== undefined) chPayload.default_sort_order = ch.default_sort_order;
                        if (ch.default_forum_layout !== undefined) chPayload.default_forum_layout = ch.default_forum_layout;
                    }

                    if (ch.permission_overwrites) {
                        const mappedOverwrites = ch.permission_overwrites
                            .filter((ow: any) => ow.type === 0 && roleIdMap[ow.id])
                            .map((ow: any) => ({
                                id: roleIdMap[ow.id],
                                type: 0,
                                allow: ow.allow,
                                deny: ow.deny
                            }));
                        if (mappedOverwrites.length > 0) chPayload.permission_overwrites = mappedOverwrites;
                    }

                    const response = await channelRateLimiter.execute(async () => {
                        return await RestAPI.post({ url: `/guilds/${newGuildId}/channels`, body: chPayload });
                    });

                    if (response?.body?.id) {
                        channelIdMap[ch.id] = response.body.id;
                    }
                } catch (e: any) {
                    if (e?.rateLimitExhausted) {
                        console.warn("[ServerCloner] Too many rate limits on channels, skipping remaining channels.");
                        channelsFailed += (remainingChannels.length - chStored);
                        if (mainProgressNotificationId) updateWithTime(`Rate limited, skipping remaining channels...`, channelsProgressEnd);
                        break;
                    }
                    channelsFailed++;
                    console.warn("[ServerCloner] Failed to clone channel:", ch.name, e);
                }
            }

            try {
                const settingsPayload: any = {};

                if (fullGuildData.rules_channel_id && channelIdMap[fullGuildData.rules_channel_id]) {
                    settingsPayload.rules_channel_id = channelIdMap[fullGuildData.rules_channel_id];
                }
                if (fullGuildData.public_updates_channel_id && channelIdMap[fullGuildData.public_updates_channel_id]) {
                    settingsPayload.public_updates_channel_id = channelIdMap[fullGuildData.public_updates_channel_id];
                }
                if (fullGuildData.system_channel_id && channelIdMap[fullGuildData.system_channel_id]) {
                    settingsPayload.system_channel_id = channelIdMap[fullGuildData.system_channel_id];
                }
                if (fullGuildData.safety_alerts_channel_id && channelIdMap[fullGuildData.safety_alerts_channel_id]) {
                    settingsPayload.safety_alerts_channel_id = channelIdMap[fullGuildData.safety_alerts_channel_id];
                }
                if (fullGuildData.afk_channel_id && channelIdMap[fullGuildData.afk_channel_id]) {
                    settingsPayload.afk_channel_id = channelIdMap[fullGuildData.afk_channel_id];
                }

                if (fullGuildData.features?.includes("COMMUNITY") || isCommunity) {
                    settingsPayload.features = fullGuildData.features || ["COMMUNITY"];
                }

                if (Object.keys(settingsPayload).length > 0) {
                    for (let attempt = 0; attempt < 5; attempt++) {
                        try {
                            await RestAPI.patch({
                                url: `/guilds/${newGuildId}`,
                                body: settingsPayload
                            });
                            break;
                        } catch (patchError: any) {
                            let errCode = patchError?.body?.code;
                            if (!errCode && patchError?.text) {
                                try { errCode = JSON.parse(patchError.text).code; } catch (_) { }
                            }
                            if (errCode === 40006) {
                                console.warn("[ServerCloner] Guild settings update blocked by Discord (40006). Skipping retry.");
                                break;
                            }

                            if (attempt < 4 && (patchError?.status === 403 || patchError?.status === 429)) {
                                const backoff = 5000 + (attempt * 3000);
                                console.warn(`[ServerCloner] Guild settings PATCH failed (attempt ${attempt + 1}/5), retrying in ${backoff / 1000}s...`);
                                await sleep(backoff);
                            } else {
                                throw patchError;
                            }
                        }
                    }
                }

                const positionUpdates: any[] = [];
                for (const cat of categories) {
                    if (channelIdMap[cat.id]) {
                        positionUpdates.push({ id: channelIdMap[cat.id], position: typeof cat.position === 'number' ? cat.position : 0 });
                    }
                }
                for (const ch of otherChannels) {
                    if (channelIdMap[ch.id]) {
                        positionUpdates.push({ id: channelIdMap[ch.id], position: typeof ch.position === 'number' ? ch.position : 0 });
                    }
                }

                if (positionUpdates.length > 0) {
                    if (mainProgressNotificationId) {
                        updateWithTime("Syncing channel positions...", settingsProgress.start);
                    }
                    const chunkSize = 50;
                    for (let i = 0; i < positionUpdates.length; i += chunkSize) {
                        await RestAPI.patch({
                            url: `/guilds/${newGuildId}/channels`,
                            body: positionUpdates.slice(i, i + chunkSize)
                        });
                    }
                }

            } catch (e) {
                console.warn("[ServerCloner] Failed to update final guild settings:", e);
            }

            if (options.cloneOnboarding) {
                try {
                    if (mainProgressNotificationId) updateWithTime(`Cloning onboarding settings...`, onboardingProgress.start);

                    const onboardingResp = await RestAPI.get({ url: `/guilds/${sourceGuild.id}/onboarding` });
                    const onboarding = (onboardingResp as any).body;

                    if (onboarding) {
                        let sfI = 0;
                        const genId = (existingId?: string) => existingId || ((BigInt(Date.now()) - 1420070400000n) << 22n | BigInt(sfI++)).toString();

                        const mappedPrompts = (onboarding.prompts || [])
                            .map((prompt: any) => ({
                                id: genId(prompt.id),
                                title: replaceEmojis(prompt.title) || "Prompt",
                                type: prompt.type || 0,
                                required: prompt.required || false,
                                single_select: prompt.single_select || false,
                                in_onboarding: prompt.in_onboarding || false,
                                options: (prompt.options || [])
                                    .map((opt: any) => {
                                        const mappedOpt: any = {
                                            id: genId(opt.id),
                                            title: replaceEmojis(opt.title) || "Option",
                                            role_ids: (opt.role_ids || [])
                                                .map((id: string) => roleIdMap[id])
                                                .filter(Boolean),
                                            channel_ids: (opt.channel_ids || [])
                                                .map((id: string) => channelIdMap[id])
                                                .filter(Boolean)
                                        };
                                        if (opt.description) mappedOpt.description = replaceEmojis(opt.description);
                                        const origEmojiId = opt.emoji_id || opt.emoji?.id || null;
                                        const origEmojiName = opt.emoji_name || opt.emoji?.name || null;
                                        const origEmojiAnimated = opt.emoji_animated || opt.emoji?.animated || false;

                                        if (origEmojiId && emojiIdMap[origEmojiId]) {
                                            mappedOpt.emoji_id = emojiIdMap[origEmojiId];
                                            mappedOpt.emoji_name = origEmojiName;
                                            mappedOpt.emoji_animated = origEmojiAnimated;
                                        } else if (origEmojiId) {
                                            mappedOpt.emoji_id = null;
                                            mappedOpt.emoji_name = null;
                                            mappedOpt.emoji_animated = false;
                                        } else {
                                            mappedOpt.emoji_id = null;
                                            mappedOpt.emoji_name = origEmojiName;
                                            mappedOpt.emoji_animated = origEmojiAnimated;
                                        }

                                        return mappedOpt;
                                    })
                                    .filter((opt: any) => opt.role_ids.length > 0 || opt.channel_ids.length > 0)
                            }))
                            .filter((prompt: any) => prompt.options.length > 0);

                        const mappedDefaultChannels = (onboarding.default_channel_ids || [])
                            .map((id: string) => channelIdMap[id])
                            .filter(Boolean);

                        const doOnboardingPut = async (enabled: boolean) => {
                            await RestAPI.put({
                                url: `/guilds/${newGuildId}/onboarding`,
                                body: {
                                    prompts: mappedPrompts,
                                    default_channel_ids: mappedDefaultChannels,
                                    enabled: enabled,
                                    mode: onboarding.mode || 0
                                }
                            });
                        };

                        await channelRateLimiter.execute(async () => {
                            try {
                                await doOnboardingPut(onboarding.enabled);
                            } catch (err: any) {
                                console.error("[ServerCloner] Onboarding update failed - Payload:", { prompts: mappedPrompts, default_channel_ids: mappedDefaultChannels, enabled: onboarding.enabled, mode: onboarding.mode || 0 });
                                console.error("[ServerCloner] Onboarding update failed - Response:", err.body || err.text);

                                let fixedAny = false;
                                if (err.body?.code === 50035 && err.body?.errors?.default_channel_ids) {
                                    const errs = err.body.errors.default_channel_ids;
                                    console.error("[ServerCloner] default_channel_ids error structure:", JSON.stringify(errs, null, 2));

                                    const rootErrors = errs._errors || [];
                                    const hasRootPermissionError = rootErrors.some((e: any) =>
                                        e.code === "DEFAULT_CHANNEL_REQUIRES_EVERYONE_ACCESS" ||
                                        e.code === "ONBOARDING_DEFAULT_CHANNEL_NOT_EVERYONE" ||
                                        (typeof e.message === "string" && e.message.includes("Default channel requires @everyone access"))
                                    );

                                    const channelsToFix = new Set<string>();

                                    if (hasRootPermissionError) {

                                        for (const id of mappedDefaultChannels) {
                                            channelsToFix.add(id);
                                        }
                                    } else {

                                        const badIndices = Object.keys(errs).filter(k => k !== "_errors");
                                        for (const idxStr of badIndices) {
                                            const channelId = mappedDefaultChannels[parseInt(idxStr, 10)];
                                            if (channelId) channelsToFix.add(channelId);
                                        }
                                    }

                                    for (const channelId of channelsToFix) {
                                        console.log(`[ServerCloner] Auto-fixing @everyone permission for default channel ${channelId}`);
                                        try {
                                            await RestAPI.put({
                                                url: `/channels/${channelId}/permissions/${newGuildId}`,
                                                body: {
                                                    type: 0,
                                                    allow: "1024",
                                                    deny: "0"
                                                }
                                            });
                                            fixedAny = true;
                                        } catch (fixErr) {
                                            console.warn(`[ServerCloner] Failed to auto-fix permission for ${channelId}:`, fixErr);
                                        }
                                    }
                                }

                                if (fixedAny) {
                                    try {
                                        console.log("[ServerCloner] Retrying onboarding after fixing permissions...");
                                        return await doOnboardingPut(onboarding.enabled);
                                    } catch (retryErr: any) {
                                        console.error("[ServerCloner] Retry onboarding failed:", retryErr.body || retryErr.text);
                                        err = retryErr;
                                    }
                                }

                                if (onboarding.enabled) {
                                    console.warn("[ServerCloner] Retrying Onboarding with enabled: false", err);
                                    try {
                                        await doOnboardingPut(false);
                                    } catch (err2: any) {
                                        console.error("[ServerCloner] Second Onboarding update failed:", err2.body || err2.text);
                                        throw err2;
                                    }
                                } else {
                                    throw err;
                                }
                            }
                        });
                    }
                } catch (e) {
                    console.warn("[ServerCloner] Failed to clone onboarding:", e);
                }
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

        try {
            NavigationRouter.transitionToGuild(newGuildId);
        } catch (e) {
            console.warn("[ServerCloner] Failed to navigate to cloned server:", e);
        }

        if (mainProgressNotificationId) {
            if (totalFailed > 0) {
                completeMainProgress(mainProgressNotificationId, `Cloned with ${totalFailed} errors`, true);
            } else {
                completeMainProgress(mainProgressNotificationId, `Successfully cloned "${guild.name}"!`, true);
            }
        }

    } catch (e: any) {
        if (!isCloning || e.message === "Cancelled" || e.message?.includes("Cancelled")) {
            return;
        }
        if (mainProgressNotificationId) {
            completeMainProgress(mainProgressNotificationId, e.message || "An error occurred while cloning", false);
        } else {
            notify("Clone Failed", e.message || "An error occurred while cloning", "error");
        }
    } finally {
        if ((globalThis as any)._clonerTimer) {
            clearInterval((globalThis as any)._clonerTimer);
            delete (globalThis as any)._clonerTimer;
        }
        isCloning = false;
        mainProgressNotificationId = null;
    }
}

const guildContextMenuPatch: NavContextMenuPatchCallback = (children: any[], props: { guild?: Guild; }) => {
    if (!props?.guild) return;

    const group = findGroupChildrenByChildId("privacy", children);
    const menuItem = (
        <Menu.MenuItem
            id="clone-server-pro"
            label="Clone Server"
            action={() => {
                openModal((modalProps: ModalProps) => (
                    <CloneModal
                        props={modalProps}
                        guild={props.guild!}
                        onClone={(options) => cloneServer(props.guild!, options)}
                    />
                ));
            }}
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
        setTimeout(() => checkForUpdates(), 5000);
    },

    stop() {
        cleanupContainer();
        isCloning = false;
        notificationContainer = null;
        mainProgressNotificationId = null;
        currentCloneGuildId = null;
        skipRolesCallback = null;
    },

    patches: [
        {
            find: '"GuildChannelStore"',
            replacement: [
                {
                    match: /isChannelGated\(.+?\)(?=&&)/,
                    replace: (m: string) => `${m}&&false`
                }
            ]
        }
    ],

    contextMenus: {
        "guild-context": guildContextMenuPatch,
        "guild-header-popout": guildContextMenuPatch
    }
});
