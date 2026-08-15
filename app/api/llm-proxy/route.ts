import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export const maxDuration = 600;

const REQUEST_TIMEOUT_MS = 600_000;
const ALLOWED_HEADERS = new Set([
    "authorization",
    "content-type",
    "x-api-key",
    "anthropic-version",
    "anthropic-beta",
    "http-referer",
    "x-title",
]);

function getProxyDispatcher(): Dispatcher | undefined {
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
        || process.env.http_proxy || process.env.HTTP_PROXY;
    return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

function isPrivateIpv4(host: string): boolean {
    const parts = host.split(".").map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [first, second] = parts;
    return first === 0
        || first === 10
        || first === 127
        || (first === 169 && second === 254)
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || (first === 100 && second >= 64 && second <= 127);
}

function validateUpstreamUrl(rawUrl: unknown): URL | null {
    if (typeof rawUrl !== "string") return null;
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        const isIpv6Literal = host.includes(":");
        if (host === "localhost"
            || host.endsWith(".localhost")
            || host.endsWith(".local")
            || host.endsWith(".internal")
            || host === "::1"
            || host === "0:0:0:0:0:0:0:1"
            || (isIpv6Literal && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host.startsWith("::ffff:")))
            || isPrivateIpv4(host)) return null;
        return url;
    } catch {
        return null;
    }
}

function sanitizeHeaders(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value)
            .filter(([name, headerValue]) => ALLOWED_HEADERS.has(name.toLowerCase()) && typeof headerValue === "string")
            .map(([name, headerValue]) => [name, String(headerValue)]),
    );
}

export async function POST(req: NextRequest) {
    const requestId = crypto.randomUUID().slice(0, 8);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
        const payload = await req.json();
        const upstreamUrl = validateUpstreamUrl(payload?.url);
        if (!upstreamUrl) {
            return NextResponse.json({ error: "LLM 上游地址无效或不允许访问" }, { status: 400 });
        }

        const headers = sanitizeHeaders(payload.headers);
        const body = typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body ?? {});
        const dispatcher = getProxyDispatcher();
        console.info(`[LLM Proxy ${requestId}] POST ${upstreamUrl.host}${upstreamUrl.pathname}`);
        const response = await (dispatcher
            ? undiciFetch(upstreamUrl, { method: "POST", headers, body, signal: controller.signal, dispatcher }) as unknown as Response
            : fetch(upstreamUrl, { method: "POST", headers, body, signal: controller.signal }));
        console.info(`[LLM Proxy ${requestId}] ${response.status} headers in ${Date.now() - startedAt}ms`);
        return new NextResponse(response.body, {
            status: response.status,
            headers: {
                "Content-Type": response.headers.get("content-type") || "application/json",
                "X-LLM-Proxy-Request-Id": requestId,
            },
        });
    } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        console.warn(`[LLM Proxy ${requestId}] failed after ${Date.now() - startedAt}ms:`, error);
        return NextResponse.json(
            { error: aborted ? "LLM 上游请求超时（600秒）" : `LLM 代理请求失败：${error instanceof Error ? error.message : String(error)}` },
            { status: aborted ? 504 : 502, headers: { "X-LLM-Proxy-Request-Id": requestId } },
        );
    } finally {
        clearTimeout(timeout);
    }
}