/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission — no host_permissions.
 * It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
 * tabs (resolveTabId in background.ts filters them).
 */

const attached = new Set<number>();

// ─── Push bindings (Runtime.addBinding) ─────────────────────────────
const activeBindings = new Map<number, Set<string>>();
let _pushEventCallback: ((tabId: number, name: string, payload: string) => void) | null = null;

export function setPushEventCallback(cb: ((tabId: number, name: string, payload: string) => void) | null): void {
  _pushEventCallback = cb;
}

// ─── CDP network-capture push ───────────────────────────────────────
// Instead of relying on page-JS fetch interception (which LinkedIn defeats by
// grabbing a fetch reference before our patch runs), we push CDP-captured
// network entries directly from the debugger event handler. This is the same
// reliable source the poll loop drains — just delivered instantly.
export const NETWORK_PUSH_BINDING = '__oc_netcapture_push';
const networkPushTabs = new Set<number>();
// Only push messaging/realtime-relevant entries — avoids flooding the pipe with
// every image/tracking request when the capture pattern is '' (capture-all).
const NETWORK_PUSH_URL_RE = /deliveryAck|deliveryAcknowledgement|messaging|realtime|messenger|mercury|voyagerMessaging/i;

export function enableNetworkPush(tabId: number): void {
  networkPushTabs.add(tabId);
}

export function disableNetworkPush(tabId: number): void {
  networkPushTabs.delete(tabId);
}

function maybePushNetworkEntry(tabId: number, entry: NetworkCaptureEntry): void {
  if (!networkPushTabs.has(tabId) || !_pushEventCallback) return;
  const url = entry.url || '';
  // WebSocket frames always pass — a realtime WS URL may not match the HTTP regex.
  const isWs = (entry.method || '').startsWith('WS_');
  if (!isWs && !NETWORK_PUSH_URL_RE.test(url)) return;
  try {
    _pushEventCallback(tabId, NETWORK_PUSH_BINDING, JSON.stringify(entry));
  } catch { /* serialization or callback failure — non-fatal */ }
}

// ─── Streaming body capture (Network.streamResourceContent) ──────────
// A long-lived realtime connection never hits loadingFinished, so
// getResponseBody can't read it. Arming streamResourceContent makes
// dataReceived carry the actual bytes, so we can read in-flight frames.
const streamArmedRequests = new Set<string>();
// How many decoded chars of each streaming response we've already emitted, so
// re-polling streamResourceContent yields only the new delta.
const streamConsumedLen = new Map<string, number>();
const wsUrlByRequestId = new Map<string, string>();
const STREAM_CAPTURE_URL_RE = /realtime|voyagerMessagingGraphQL|messengerConversations|messengerMessages|mercury|subscribe/i;

function decodeBase64Utf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

const tabFrameContexts = new Map<number, Map<string, number>>();
const frameTargets = new Map<string, string>();
const frameTargetKeys = new Map<string, string>();
let frameTargetCleanupRegistered = false;

// SharedWorker/Worker target tracking for network capture.
// Maps worker targetId → the tabId whose network capture should receive the events.
const workerTargetToTab = new Map<string, number>();

// Large cap so agents stop hitting silent JSON.parse failures on real API bodies.
// See src/browser/cdp.ts CDP_RESPONSE_BODY_CAPTURE_LIMIT for the matching constant
// on the direct-CDP path. Keep in sync.
const CDP_RESPONSE_BODY_CAPTURE_LIMIT = 8 * 1024 * 1024;
const CDP_REQUEST_BODY_CAPTURE_LIMIT = 1 * 1024 * 1024;

type NetworkCaptureEntry = {
  kind: 'cdp';
  url: string;
  method: string;
  requestHeaders?: Record<string, string>;
  requestBodyKind?: string;
  requestBodyPreview?: string;
  requestBodyFullSize?: number;
  requestBodyTruncated?: boolean;
  responseStatus?: number;
  responseContentType?: string;
  responseHeaders?: Record<string, string>;
  responsePreview?: string;
  responseBodyFullSize?: number;
  responseBodyTruncated?: boolean;
  timestamp: number;
};

type NetworkCaptureState = {
  patterns: string[];
  entries: NetworkCaptureEntry[];
  requestToIndex: Map<string, number>;
};

export type DownloadWaitResult = {
  downloaded: boolean;
  id?: number;
  filename?: string;
  url?: string;
  finalUrl?: string;
  mime?: string;
  totalBytes?: number;
  state?: string;
  danger?: string;
  error?: string;
  elapsedMs: number;
};

const networkCaptures = new Map<number, NetworkCaptureState>();
/** Check if a URL can be attached via CDP — only allow http(s) and blank pages. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}

export async function ensureAttached(tabId: number, aggressiveRetry: boolean = false): Promise<void> {
  // Verify the tab URL is debuggable before attempting attach
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl(tab.url)) {
      // Invalidate cache if previously attached
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? 'unknown'}`);
    }
  } catch (e) {
    // Re-throw our own error, catch only chrome.tabs.get failures
    if (e instanceof Error && e.message.startsWith('Cannot debug tab')) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }

  if (attached.has(tabId)) {
    // Verify the debugger is still actually attached by sending a harmless command
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1', returnByValue: true,
      });
      return; // Still attached and working
    } catch {
      // Stale cache entry — need to re-attach
      attached.delete(tabId);
    }
  }

  // Retry attach up to 3 times — other extensions (1Password, Playwright MCP Bridge)
  // can temporarily interfere with chrome.debugger. A short delay usually resolves it.
  // Normal commands: 2 retries, 500ms delay (fast fail for non-browser use)
  // Browser commands: 5 retries, 1500ms delay (aggressive, tolerates extension interference)
  const MAX_ATTACH_RETRIES = aggressiveRetry ? 5 : 2;
  const RETRY_DELAY_MS = aggressiveRetry ? 1500 : 500;
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTACH_RETRIES; attempt++) {
    try {
      // Force detach first to clear any stale state from other extensions
      try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
      await chrome.debugger.attach({ tabId }, '1.3');
      lastError = '';
      break; // Success
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_ATTACH_RETRIES) {
        console.warn(`[opencli] attach attempt ${attempt}/${MAX_ATTACH_RETRIES} failed: ${lastError}, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        // Re-verify tab URL before retrying (it may have changed)
        try {
          const tab = await chrome.tabs.get(tabId);
          if (!isDebuggableUrl(tab.url)) {
            lastError = `Tab URL changed to ${tab.url} during retry`;
            break; // Don't retry if URL became un-debuggable
          }
        } catch {
          // Tab is gone — don't fail early here.
          // Later retry layers can re-resolve a fresh automation tab/window.
          lastError = `Tab ${tabId} no longer exists`;
          // Don't break; fall through to retry
        }
      }
    }
  }

  if (lastError) {
    // Log detailed diagnostics for debugging extension conflicts
    let finalUrl = 'unknown';
    let finalWindowId = 'unknown';
    try {
      const tab = await chrome.tabs.get(tabId);
      finalUrl = tab.url ?? 'undefined';
      finalWindowId = String(tab.windowId);
    } catch { /* tab gone */ }
    console.warn(`[opencli] attach failed for tab ${tabId}: url=${finalUrl}, windowId=${finalWindowId}, error=${lastError}`);

    const hint = lastError.includes('chrome-extension://')
      ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
      : '';
    throw new Error(`attach failed: ${lastError}${hint}`);
  }
  attached.add(tabId);

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  } catch {
    // Some pages may not need explicit enable
  }
}

export async function evaluate(tabId: number, expression: string, aggressiveRetry: boolean = false): Promise<unknown> {
  // Retry the entire evaluate (attach + command).
  // Normal: 2 retries. Browser: 3 retries (tolerates extension interference).
  const MAX_EVAL_RETRIES = aggressiveRetry ? 3 : 2;
  for (let attempt = 1; attempt <= MAX_EVAL_RETRIES; attempt++) {
    try {
      await ensureAttached(tabId, aggressiveRetry);

      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }) as {
        result?: { type: string; value?: unknown; description?: string; subtype?: string };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };

      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || 'Eval error';
        throw new Error(errMsg);
      }

      return result.result?.value;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Only retry on attach/debugger errors, not on JS eval errors
      const isNavigateError = msg.includes('Inspected target navigated') || msg.includes('Target closed');
      const isAttachError = isNavigateError || msg.includes('attach failed') || msg.includes('Debugger is not attached')
        || msg.includes('chrome-extension://');
      if (isAttachError && attempt < MAX_EVAL_RETRIES) {
        attached.delete(tabId); // Force re-attach on next attempt
        // SPA navigations recover quickly; debugger detach needs longer
        const retryMs = isNavigateError ? 200 : 500;
        await new Promise(resolve => setTimeout(resolve, retryMs));
        continue;
      }
      throw e;
    }
  }
  throw new Error('evaluate: max retries exhausted');
}

export const evaluateAsync = evaluate;

/**
 * Capture a screenshot via CDP Page.captureScreenshot.
 * Returns base64-encoded image data.
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number } = {},
): Promise<string> {
  await ensureAttached(tabId);

  const format = options.format ?? 'png';
  const fullPage = options.fullPage === true;
  const overrideWidth = options.width && options.width > 0 ? Math.ceil(options.width) : undefined;
  // height is ignored under fullPage so the existing measure-from-content path stays unchanged for users who pass --height alongside --full-page.
  const overrideHeight = !fullPage && options.height && options.height > 0 ? Math.ceil(options.height) : undefined;
  const needsOverride = fullPage || overrideWidth !== undefined || overrideHeight !== undefined;

  if (needsOverride) {
    // When width is set, apply it first so layout reflows before we read content size.
    if (overrideWidth !== undefined && fullPage) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width: overrideWidth,
        height: 0,
        deviceScaleFactor: 1,
      });
    }
    let finalWidth = overrideWidth ?? 0;
    let finalHeight = overrideHeight ?? 0;
    if (fullPage) {
      const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics') as {
        contentSize?: { width: number; height: number };
        cssContentSize?: { width: number; height: number };
      };
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) {
        if (finalWidth === 0) finalWidth = Math.ceil(size.width);
        finalHeight = Math.ceil(size.height);
      }
    }
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor: 1,
    });
  }

  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }

    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params) as {
      data: string; // base64-encoded
    };

    return result.data;
  } finally {
    if (needsOverride) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }
}

/**
 * Set local file paths on a file input element via CDP DOM.setFileInputFiles.
 * This bypasses the need to send large base64 payloads through the message channel —
 * Chrome reads the files directly from the local filesystem.
 *
 * @param tabId - Target tab ID
 * @param files - Array of absolute local file paths
 * @param selector - CSS selector to find the file input (optional, defaults to first file input)
 */
export async function setFileInputFiles(
  tabId: number,
  files: string[],
  selector?: string,
): Promise<void> {
  await ensureAttached(tabId);

  // Enable DOM domain (required for DOM.querySelector and DOM.setFileInputFiles)
  await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');

  // Get the document root
  const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument') as {
    root: { nodeId: number };
  };

  // Find the file input element
  const query = selector || 'input[type="file"]';
  const result = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: query,
  }) as { nodeId: number };

  if (!result.nodeId) {
    throw new Error(`No element found matching selector: ${query}`);
  }

  // Set files directly via CDP — Chrome reads from local filesystem
  await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
    files,
    nodeId: result.nodeId,
  });
}

function matchesDownloadPattern(item: chrome.downloads.DownloadItem, pattern: string): boolean {
  if (!pattern) return true;
  const haystack = [
    item.filename,
    item.url,
    item.finalUrl,
    item.mime,
  ].filter(Boolean).join('\n').toLowerCase();
  return haystack.includes(pattern.toLowerCase());
}

function downloadResult(item: chrome.downloads.DownloadItem, startedAt: number): DownloadWaitResult {
  return {
    downloaded: item.state === 'complete',
    id: item.id,
    filename: item.filename,
    url: item.url,
    finalUrl: item.finalUrl,
    mime: item.mime,
    totalBytes: item.totalBytes,
    state: item.state,
    danger: item.danger,
    error: item.error,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function waitForDownload(pattern: string = '', timeoutMs: number = 30000): Promise<DownloadWaitResult> {
  const startedAt = Date.now();
  const timeout = Math.max(1, timeoutMs);

  return await new Promise<DownloadWaitResult>((resolve) => {
    let done = false;
    const inProgressIds = new Set<number>();
    const finish = (result: DownloadWaitResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(result);
    };

    const inspectById = async (id: number) => {
      const items = await chrome.downloads.search({ id });
      const item = items[0];
      if (!item || !matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(id);
      if (item.state === 'complete' || item.state === 'interrupted') finish(downloadResult(item, startedAt));
    };

    const onCreated = (item: chrome.downloads.DownloadItem) => {
      if (!matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(item.id);
      if (item.state === 'complete' || item.state === 'interrupted') finish(downloadResult(item, startedAt));
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (!delta.id) return;
      if (!inProgressIds.has(delta.id) && !delta.filename && !delta.url) return;
      if (delta.filename?.current || delta.url?.current) {
        void inspectById(delta.id);
        return;
      }
      if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
        void inspectById(delta.id);
      }
    };
    const timer = setTimeout(() => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: `No download matched "${pattern || '*'}" within ${timeout}ms`,
        elapsedMs: Date.now() - startedAt,
      });
    }, timeout);

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);

    void chrome.downloads.search({
      limit: 50,
      orderBy: ['-startTime'],
      startedAfter: new Date(startedAt - Math.max(timeout, 1000)).toISOString(),
    }).then((recent) => {
      if (done) return;
      const completed = recent.find((item) => item.state === 'complete' && matchesDownloadPattern(item, pattern));
      if (completed) {
        finish(downloadResult(completed, startedAt));
        return;
      }
      for (const item of recent) {
        if (item.state === 'in_progress' && matchesDownloadPattern(item, pattern)) inProgressIds.add(item.id);
      }
    }).catch((err) => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

function frameTargetKey(tabId: number, frameId: string): string {
  return `${tabId}:${frameId}`;
}

function registerFrameTargetCleanup(): void {
  if (frameTargetCleanupRegistered) return;
  frameTargetCleanupRegistered = true;
  chrome.debugger.onEvent.addListener((_source, method, params: any) => {
    if (method === 'Target.detachedFromTarget') {
      const targetId = String(params?.targetId || '');
      clearFrameTarget(targetId);
    }
  });
}

function clearFrameTarget(targetId: string): void {
  if (!targetId) return;
  const key = frameTargetKeys.get(targetId);
  if (key) frameTargets.delete(key);
  frameTargetKeys.delete(targetId);
}

async function ensureFrameTarget(
  tabId: number,
  frameId: string,
  aggressiveRetry: boolean = false,
  targetUrl?: string,
): Promise<string> {
  registerFrameTargetCleanup();
  await ensureAttached(tabId, aggressiveRetry);
  const key = frameTargetKey(tabId, frameId);
  const existing = frameTargets.get(key);
  if (existing) return existing;

  await chrome.debugger.sendCommand({ tabId }, 'Target.setDiscoverTargets', { discover: true }).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: 'iframe', exclude: false }],
  }).catch(() => {});
  const targetId = await resolveFrameTargetId(tabId, frameId, targetUrl);
  try {
    await chrome.debugger.attach({ targetId } as chrome.debugger.Debuggee, '1.3');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('Another debugger is already attached')) throw err;
  }
  frameTargets.set(key, targetId);
  frameTargetKeys.set(targetId, key);
  return targetId;
}

async function resolveFrameTargetId(tabId: number, frameId: string, targetUrl?: string): Promise<string> {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargets').catch(() => null) as
    | { targetInfos?: Array<{ targetId?: string; id?: string; type?: string; url?: string }> }
    | null;
  const targets = result?.targetInfos ?? [];
  const frameTarget = targets.find((candidate) => {
    const candidateId = candidate.targetId || candidate.id;
    return candidate.type === 'iframe'
      && (
        candidateId === frameId
        || (!!targetUrl && candidate.url === targetUrl)
      );
  });
  const targetId = frameTarget?.targetId || frameTarget?.id;
  if (targetId) return targetId;
  const candidates = targets
    .filter((target) => target.type === 'iframe')
    .map((target) => `${target.targetId || target.id || '?'} ${target.url || ''}`)
    .join('; ');
  throw new Error(`No iframe target found for frame ${frameId}${targetUrl ? ` (${targetUrl})` : ''}. Candidates: ${candidates || 'none'}`);
}

export async function sendCommandInFrameTarget(
  tabId: number,
  frameId: string,
  method: string,
  params: Record<string, unknown> = {},
  aggressiveRetry: boolean = false,
  _timeoutMs: number = 30_000,
  targetUrl?: string,
): Promise<unknown> {
  const targetId = await ensureFrameTarget(tabId, frameId, aggressiveRetry, targetUrl);
  const target = { targetId } as chrome.debugger.Debuggee;
  return chrome.debugger.sendCommand(target, method, params);
}

export async function insertText(
  tabId: number,
  text: string,
): Promise<void> {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
}

export function registerFrameTracking(): void {
  registerFrameTargetCleanup();
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const tabId = source.tabId;
    if (!tabId) return;

    if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      if (!context?.auxData?.frameId || context.auxData.isDefault !== true) return;
      const frameId = context.auxData.frameId as string;
      if (!tabFrameContexts.has(tabId)) {
        tabFrameContexts.set(tabId, new Map());
      }
      tabFrameContexts.get(tabId)!.set(frameId, context.id);
    }

    if (method === 'Runtime.executionContextDestroyed') {
      const ctxId = params.executionContextId;
      const contexts = tabFrameContexts.get(tabId);
      if (contexts) {
        for (const [fid, cid] of contexts) {
          if (cid === ctxId) { contexts.delete(fid); break; }
        }
      }
    }

    if (method === 'Runtime.executionContextsCleared') {
      tabFrameContexts.delete(tabId);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabFrameContexts.delete(tabId);
  });
}

export async function getFrameTree(tabId: number): Promise<any> {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
}

export async function evaluateInFrame(
  tabId: number,
  expression: string,
  frameId: string,
  aggressiveRetry: boolean = false,
): Promise<unknown> {
  await ensureAttached(tabId, aggressiveRetry);

  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => {});

  const contexts = tabFrameContexts.get(tabId);
  const contextId = contexts?.get(frameId);

  if (contextId === undefined) {
    await sendCommandInFrameTarget(tabId, frameId, 'Runtime.enable', {}, aggressiveRetry).catch(() => undefined);
    const result = await sendCommandInFrameTarget(tabId, frameId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, aggressiveRetry) as {
      result?: { type: string; value?: unknown; description?: string; subtype?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };

    if (result.exceptionDetails) {
      const errMsg = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Eval error';
      throw new Error(errMsg);
    }

    return result.result?.value;
  }

  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
  }) as {
    result?: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Eval error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

function normalizeCapturePatterns(pattern?: string): string[] {
  return String(pattern || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
}

function shouldCaptureUrl(url: string | undefined, patterns: string[]): boolean {
  if (!url) return false;
  if (!patterns.length) return true;
  return patterns.some((pattern) => url.includes(pattern));
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[String(key)] = String(value);
  }
  return out;
}

function getOrCreateNetworkCaptureEntry(tabId: number, requestId: string, fallback?: {
  url?: string;
  method?: string;
  requestHeaders?: Record<string, string>;
}): NetworkCaptureEntry | null {
  const state = networkCaptures.get(tabId);
  if (!state) return null;
  const existingIndex = state.requestToIndex.get(requestId);
  if (existingIndex !== undefined) {
    return state.entries[existingIndex] || null;
  }
  const url = fallback?.url || '';
  if (!shouldCaptureUrl(url, state.patterns)) return null;
  const entry: NetworkCaptureEntry = {
    kind: 'cdp',
    url,
    method: fallback?.method || 'GET',
    requestHeaders: fallback?.requestHeaders || {},
    timestamp: Date.now(),
  };
  state.entries.push(entry);
  state.requestToIndex.set(requestId, state.entries.length - 1);
  return entry;
}

export async function startNetworkCapture(
  tabId: number,
  pattern?: string,
): Promise<void> {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  networkCaptures.set(tabId, {
    patterns: normalizeCapturePatterns(pattern),
    entries: [],
    requestToIndex: new Map(),
  });
  // Discover and attach to SharedWorker/Worker targets for realtime capture.
  // Workers maintain their own network connections (WebSocket, fetch) invisible
  // to the parent tab's Network domain.
  await attachWorkerTargets(tabId);
}

async function attachWorkerTargets(tabId: number): Promise<void> {
  // chrome.debugger.getTargets() (extension API) sees browser-level targets —
  // including SharedWorkers — that tab-scoped CDP Target.getTargets misses.
  // LinkedIn's realtime connection lives in a SharedWorker, so this is the only
  // way to reach it.
  try {
    const all = await new Promise<chrome.debugger.TargetInfo[]>((resolve) => {
      chrome.debugger.getTargets((targets) => resolve(targets || []));
    });
    for (const target of all) {
      const ttype = target.type || '';
      const url = target.url || '';
      // Attach to workers/service-workers on linkedin.com (the realtime host).
      const isWorkerish = ttype === 'worker' || ttype === 'shared_worker' || ttype === 'service_worker' || ttype === 'other';
      if (isWorkerish && /linkedin\.com/i.test(url) && target.id && !target.attached) {
        await attachSingleWorkerTarget(tabId, target.id);
      }
    }
  } catch {
    // Worker discovery is best-effort
  }
}

async function attachSingleWorkerTarget(tabId: number, targetId: string): Promise<void> {
  if (workerTargetToTab.has(targetId)) return;
  try {
    await chrome.debugger.attach({ targetId } as chrome.debugger.Debuggee, '1.3');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('Another debugger is already attached')) return;
    // Already attached is fine — we can still track it
  }
  workerTargetToTab.set(targetId, tabId);
  try {
    await chrome.debugger.sendCommand({ targetId } as chrome.debugger.Debuggee, 'Network.enable');
  } catch { /* Worker may not support Network domain */ }
}

// ─── Realtime capture helpers (SharedWorker realtime channel) ────────

/**
 * Enumerate ALL inspectable targets via the chrome.debugger extension API.
 * Unlike CDP Target.getTargets (tab-scoped), chrome.debugger.getTargets()
 * returns browser-level targets too — including the SharedWorker that hosts
 * LinkedIn's realtime connection, which is invisible to tab-scoped discovery.
 */
export async function enumerateTargets(tabId: number): Promise<Array<{ id?: string; type?: string; url?: string; title?: string; attached?: boolean; tabId?: number }>> {
  try {
    const all = await new Promise<chrome.debugger.TargetInfo[]>((resolve) => {
      chrome.debugger.getTargets((targets) => resolve(targets || []));
    });
    return all.map((t) => ({ id: t.id, type: t.type, url: t.url, title: t.title, attached: t.attached, tabId: t.tabId }));
  } catch {
    return [];
  }
}

/**
 * Force LinkedIn's realtime connection to reconnect so we can capture it.
 * The realtime stream lives in a SharedWorker and persists across page reloads,
 * so it was established before our capture armed. Toggling offline/online on the
 * tab AND every attached worker target drops that connection; when it reconnects
 * under capture we see requestWillBeSent → responseReceived → arm streamResourceContent.
 */
export async function forceRealtimeReconnect(tabId: number): Promise<{ toggledTargets: number }> {
  await ensureAttached(tabId);
  // Make sure every worker is attached + Network-enabled before we toggle.
  await attachWorkerTargets(tabId);

  const debuggees: chrome.debugger.Debuggee[] = [{ tabId }];
  for (const [targetId, owner] of workerTargetToTab.entries()) {
    if (owner === tabId) debuggees.push({ targetId } as chrome.debugger.Debuggee);
  }

  const offline = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

  try {
    for (const d of debuggees) {
      try { await chrome.debugger.sendCommand(d, 'Network.emulateNetworkConditions', offline); } catch { /* target may not support */ }
    }
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    // ALWAYS restore online, even if the offline loop threw — never leave a tab
    // stranded offline. Retried + clears any prior stuck emulation.
    await restoreOnline(debuggees);
  }
  return { toggledTargets: debuggees.length };
}

/** Force targets back online (clears any stuck offline emulation). Idempotent. */
async function restoreOnline(debuggees: chrome.debugger.Debuggee[]): Promise<void> {
  const online = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  for (const d of debuggees) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await chrome.debugger.sendCommand(d, 'Network.enable');
        await chrome.debugger.sendCommand(d, 'Network.emulateNetworkConditions', online);
        break;
      } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
  }
}

/**
 * Clear any network emulation on a tab (and its workers) — the self-heal for a
 * tab left offline by an interrupted forceRealtimeReconnect. Safe to call before
 * navigation; CDP commands travel over the debugger, not the tab's network, so
 * this works even when the tab is currently offline.
 */
export async function ensureOnline(tabId: number): Promise<void> {
  try { await ensureAttached(tabId); } catch { return; }
  // Tab-only — the offline emulation that breaks navigation lives on the tab.
  // Iterating (possibly-stale) worker targets here can hang on dead debuggees.
  await restoreOnline([{ tabId }]);
}

export async function readNetworkCapture(tabId: number): Promise<NetworkCaptureEntry[]> {
  const state = networkCaptures.get(tabId);
  if (!state) return [];
  const entries = state.entries.slice();
  state.entries = [];
  state.requestToIndex.clear();
  return entries;
}

export function hasActiveNetworkCapture(tabId: number): boolean {
  return networkCaptures.has(tabId);
}

function clearFrameTargetsForTab(tabId: number): void {
  for (const [key, targetId] of [...frameTargets.entries()]) {
    if (!key.startsWith(`${tabId}:`)) continue;
    frameTargets.delete(key);
    frameTargetKeys.delete(targetId);
    chrome.debugger.detach({ targetId } as chrome.debugger.Debuggee).catch(() => {});
  }
}

export async function detach(tabId: number): Promise<void> {
  clearFrameTargetsForTab(tabId);
  clearWorkerTargetsForTab(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  networkCaptures.delete(tabId);
  tabFrameContexts.delete(tabId);
  activeBindings.delete(tabId);
  networkPushTabs.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

function clearWorkerTargetsForTab(tabId: number): void {
  for (const [targetId, ownerTabId] of [...workerTargetToTab.entries()]) {
    if (ownerTabId !== tabId) continue;
    workerTargetToTab.delete(targetId);
    chrome.debugger.detach({ targetId } as chrome.debugger.Debuggee).catch(() => {});
  }
}

export function registerListeners(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    networkCaptures.delete(tabId);
    tabFrameContexts.delete(tabId);
    activeBindings.delete(tabId);
    networkPushTabs.delete(tabId);
    clearFrameTargetsForTab(tabId);
    clearWorkerTargetsForTab(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) {
      attached.delete(source.tabId);
      networkCaptures.delete(source.tabId);
      tabFrameContexts.delete(source.tabId);
      activeBindings.delete(source.tabId);
      networkPushTabs.delete(source.tabId);
      clearFrameTargetsForTab(source.tabId);
      return;
    }
    if (source.targetId) clearFrameTarget(source.targetId);
  });
  // Invalidate attached cache when tab URL changes to non-debuggable
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await detach(tabId);
    }
  });
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    // Resolve tabId: direct tab events have source.tabId; worker target events
    // have source.targetId which we map back to the parent tab.
    let tabId = source.tabId;
    if (!tabId && source.targetId) {
      tabId = workerTargetToTab.get(source.targetId);
    }
    if (!tabId) return;
    const state = networkCaptures.get(tabId);
    if (!state) return;
    const eventParams = params as Record<string, any> | undefined;
    // Use the correct debuggee for CDP commands: targetId for workers, tabId for tabs
    const debuggee: chrome.debugger.Debuggee = source.targetId && workerTargetToTab.has(source.targetId)
      ? { targetId: source.targetId }
      : { tabId };

    if (method === 'Network.requestWillBeSent') {
      const requestId = String(eventParams?.requestId || '');
      const request = eventParams?.request as {
        url?: string;
        method?: string;
        headers?: Record<string, unknown>;
        postData?: string;
        hasPostData?: boolean;
      } | undefined;
      const entry = getOrCreateNetworkCaptureEntry(tabId, requestId, {
        url: request?.url,
        method: request?.method,
        requestHeaders: normalizeHeaders(request?.headers),
      });
      if (!entry) return;
      entry.requestBodyKind = request?.hasPostData ? 'string' : 'empty';
      {
        const raw = String(request?.postData || '');
        const fullSize = raw.length;
        const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
        entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
        entry.requestBodyFullSize = fullSize;
        entry.requestBodyTruncated = truncated;
      }
      try {
        const postData = await chrome.debugger.sendCommand(debuggee, 'Network.getRequestPostData', { requestId }) as { postData?: string };
        if (postData?.postData) {
          const raw = postData.postData;
          const fullSize = raw.length;
          const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
          entry.requestBodyKind = 'string';
          entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
          entry.requestBodyFullSize = fullSize;
          entry.requestBodyTruncated = truncated;
        }
      } catch {
        // Optional; some requests do not expose postData.
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const requestId = String(eventParams?.requestId || '');
      const response = eventParams?.response as {
        url?: string;
        mimeType?: string;
        status?: number;
        headers?: Record<string, unknown>;
      } | undefined;
      const entry = getOrCreateNetworkCaptureEntry(tabId, requestId, {
        url: response?.url,
      });
      if (!entry) return;
      entry.responseStatus = response?.status;
      entry.responseContentType = response?.mimeType || '';
      entry.responseHeaders = normalizeHeaders(response?.headers);

      // Arm streaming capture for realtime connections so their in-flight
      // bytes become readable via dataReceived. Only when push is active.
      if (networkPushTabs.has(tabId) && STREAM_CAPTURE_URL_RE.test(entry.url || '') && !streamArmedRequests.has(requestId)) {
        // Bound the set — realtime connections rotate, so armed IDs accumulate.
        if (streamArmedRequests.size > 500) { streamArmedRequests.clear(); streamConsumedLen.clear(); }
        streamArmedRequests.add(requestId);
        try {
          const buffered = await chrome.debugger.sendCommand(debuggee, 'Network.streamResourceContent', { requestId }) as { bufferedData?: string };
          if (buffered?.bufferedData) {
            const decoded = decodeBase64Utf8(buffered.bufferedData);
            streamConsumedLen.set(requestId, decoded.length);
            const bufEntry: NetworkCaptureEntry = {
              kind: 'cdp',
              url: entry.url,
              method: 'STREAM_BUFFERED',
              timestamp: Date.now(),
              responsePreview: decoded,
              responseContentType: entry.responseContentType,
              responseHeaders: entry.responseHeaders,
              responseBodyFullSize: buffered.bufferedData.length,
            };
            state.entries.push(bufEntry);
            maybePushNetworkEntry(tabId, bufEntry);
          }
        } catch { /* streamResourceContent unsupported or request already done */ }
      }
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = String(eventParams?.requestId || '');
      streamArmedRequests.delete(requestId);
      streamConsumedLen.delete(requestId);
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      try {
        const body = await chrome.debugger.sendCommand(debuggee, 'Network.getResponseBody', { requestId }) as {
          body?: string;
          base64Encoded?: boolean;
        };
        if (typeof body?.body === 'string') {
          const fullSize = body.body.length;
          const truncated = fullSize > CDP_RESPONSE_BODY_CAPTURE_LIMIT;
          const stored = truncated ? body.body.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT) : body.body;
          entry.responsePreview = body.base64Encoded ? `base64:${stored}` : stored;
          entry.responseBodyFullSize = fullSize;
          entry.responseBodyTruncated = truncated;
        }
      } catch {
        // Optional; bodies are unavailable for some requests (e.g. uploads).
      }
      // Push the finalized entry (includes request body for delivery ACKs).
      maybePushNetworkEntry(tabId, entry);
      return;
    }

    // SSE (Server-Sent Events) — fires for each message on an open EventSource
    // connection. This captures realtime streaming data (e.g. LinkedIn messaging)
    // that Network.loadingFinished never sees because the connection stays open.
    if (method === 'Network.eventSourceMessageReceived') {
      const requestId = String(eventParams?.requestId || '');
      const data = String(eventParams?.data || '');
      if (!data) return;
      const parentIndex = state.requestToIndex.get(requestId);
      const parentEntry = parentIndex !== undefined ? state.entries[parentIndex] : undefined;
      const url = parentEntry?.url || '';
      if (!shouldCaptureUrl(url || 'eventSourceMessage', state.patterns)) return;
      const fullSize = data.length;
      const truncated = fullSize > CDP_RESPONSE_BODY_CAPTURE_LIMIT;
      const sseEntry: NetworkCaptureEntry = {
        kind: 'cdp',
        url: url || `sse://${eventParams?.eventName || 'message'}`,
        method: 'SSE',
        timestamp: Date.now(),
        responsePreview: truncated ? data.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT) : data,
        responseBodyFullSize: fullSize,
        responseBodyTruncated: truncated,
      };
      state.entries.push(sseEntry);
      maybePushNetworkEntry(tabId, sseEntry);
      return;
    }

    // Streaming data detection — fires for each chunk on any connection.
    // For long-lived streaming requests, loadingFinished never fires.
    // dataReceived lets us detect and read buffered data.
    if (method === 'Network.dataReceived') {
      const requestId = String(eventParams?.requestId || '');
      const dataLength = Number(eventParams?.dataLength || 0);
      if (!requestId || !dataLength) return;

      const parentIndex = state.requestToIndex.get(requestId);
      if (parentIndex === undefined) return;
      const parentEntry = state.entries[parentIndex];
      if (!parentEntry) return;

      const url = parentEntry.url || '';
      if (!STREAM_CAPTURE_URL_RE.test(url) && !/messaging|mercury/i.test(url)) return;
      if (!shouldCaptureUrl(url, state.patterns)) return;

      // Re-poll streamResourceContent on every dataReceived: it returns the full
      // buffer received so far, so we diff against what we've already emitted and
      // push only the new delta. This reliably reads long-lived SSE streams like
      // /realtime/connect (whose inline dataReceived.data is unreliable) and any
      // realtime connection whose responseReceived we missed. Enabling streaming
      // is idempotent, so repeated calls are safe.
      if (networkPushTabs.has(tabId) && STREAM_CAPTURE_URL_RE.test(url)) {
        try {
          const sc = await chrome.debugger.sendCommand(debuggee, 'Network.streamResourceContent', { requestId }) as { bufferedData?: string };
          if (sc?.bufferedData) {
            streamArmedRequests.add(requestId);
            const full = decodeBase64Utf8(sc.bufferedData);
            const consumed = streamConsumedLen.get(requestId) || 0;
            if (full.length > consumed) {
              const delta = full.slice(consumed);
              streamConsumedLen.set(requestId, full.length);
              const chunkEntry: NetworkCaptureEntry = {
                kind: 'cdp', url, method: 'STREAM_CHUNK', timestamp: Date.now(),
                responsePreview: delta,
                responseContentType: parentEntry.responseContentType,
                responseHeaders: parentEntry.responseHeaders,
                responseBodyFullSize: delta.length,
              };
              state.entries.push(chunkEntry);
              maybePushNetworkEntry(tabId, chunkEntry);
            }
          }
        } catch { /* streamResourceContent unsupported or request finished */ }
        return;
      }

      // Non-realtime streaming (e.g. long messaging fetch): fall back to inline
      // data if present, else the debounced getResponseBody path below.
      const inlineData = typeof eventParams?.data === 'string' ? eventParams.data : '';
      if (inlineData) {
        const decoded = decodeBase64Utf8(inlineData);
        const chunkEntry: NetworkCaptureEntry = {
          kind: 'cdp', url, method: 'STREAM_CHUNK', timestamp: Date.now(),
          responsePreview: decoded,
          responseContentType: parentEntry.responseContentType,
          responseHeaders: parentEntry.responseHeaders,
          responseBodyFullSize: inlineData.length,
        };
        state.entries.push(chunkEntry);
        maybePushNetworkEntry(tabId, chunkEntry);
        return;
      }

      // Debounce: only process once per second per request
      const now = Date.now();
      const lastSeen = (parentEntry as any)._lastDataReceived || 0;
      if (now - lastSeen < 1000) return;
      (parentEntry as any)._lastDataReceived = now;

      // Try to read buffered response body (may fail for in-progress requests)
      try {
        const body = await chrome.debugger.sendCommand(debuggee, 'Network.getResponseBody', { requestId }) as {
          body?: string;
          base64Encoded?: boolean;
        };
        if (body?.body) {
          const fullSize = body.body.length;
          const truncated = fullSize > CDP_RESPONSE_BODY_CAPTURE_LIMIT;
          const stored = truncated ? body.body.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT) : body.body;
          const streamEntry: NetworkCaptureEntry = {
            kind: 'cdp',
            url,
            method: 'STREAM',
            timestamp: now,
            responsePreview: body.base64Encoded ? `base64:${stored}` : stored,
            responseBodyFullSize: fullSize,
            responseBodyTruncated: truncated,
          };
          state.entries.push(streamEntry);
          maybePushNetworkEntry(tabId, streamEntry);
          return;
        }
      } catch { /* getResponseBody fails on in-progress requests */ }

      const streamSignalEntry: NetworkCaptureEntry = {
        kind: 'cdp',
        url,
        method: 'STREAM_SIGNAL',
        timestamp: now,
        responsePreview: `streaming:${dataLength}bytes`,
      };
      state.entries.push(streamSignalEntry);
      maybePushNetworkEntry(tabId, streamSignalEntry);
      return;
    }

    // WebSocket lifecycle — LinkedIn realtime may run over a WebSocket (often in
    // a SharedWorker). Unlike HTTP streams, live frames fire even on a socket
    // opened before capture, so this can tap an already-connected realtime WS.
    if (method === 'Network.webSocketCreated') {
      const wsUrl = String(eventParams?.url || '');
      wsUrlByRequestId.set(String(eventParams?.requestId || ''), wsUrl);
      const wsEntry: NetworkCaptureEntry = {
        kind: 'cdp', url: wsUrl, method: 'WS_CREATED', timestamp: Date.now(),
        responsePreview: '',
      };
      state.entries.push(wsEntry);
      maybePushNetworkEntry(tabId, wsEntry);
      return;
    }
    if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
      const reqId = String(eventParams?.requestId || '');
      const wsUrl = wsUrlByRequestId.get(reqId) || `ws://${reqId}`;
      const frame = eventParams?.response as { payloadData?: string; opcode?: number } | undefined;
      const payload = String(frame?.payloadData || '');
      if (!payload) return;
      const wsEntry: NetworkCaptureEntry = {
        kind: 'cdp',
        url: wsUrl,
        method: method === 'Network.webSocketFrameReceived' ? 'WS_RECV' : 'WS_SENT',
        timestamp: Date.now(),
        responsePreview: payload.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT),
        responseBodyFullSize: payload.length,
      };
      state.entries.push(wsEntry);
      maybePushNetworkEntry(tabId, wsEntry);
      return;
    }

    // Push bindings: Runtime.bindingCalled fires when page JS calls a bound function
    if (method === 'Runtime.bindingCalled') {
      const name = String(eventParams?.name || '');
      const payload = String(eventParams?.payload || '');
      if (name && _pushEventCallback) {
        const bindings = activeBindings.get(tabId);
        if (bindings?.has(name)) {
          _pushEventCallback(tabId, name, payload);
        }
      }
      return;
    }
  });
}

export async function addBinding(tabId: number, name: string): Promise<void> {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.addBinding', { name });
  let bindings = activeBindings.get(tabId);
  if (!bindings) {
    bindings = new Set();
    activeBindings.set(tabId, bindings);
  }
  bindings.add(name);
}

export async function removeBinding(tabId: number, name: string): Promise<void> {
  const bindings = activeBindings.get(tabId);
  if (bindings) {
    bindings.delete(name);
    if (bindings.size === 0) activeBindings.delete(tabId);
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.removeBinding', { name });
  } catch { /* binding may already be gone */ }
}
