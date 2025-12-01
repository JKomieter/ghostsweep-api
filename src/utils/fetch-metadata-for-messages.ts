/* eslint-disable @typescript-eslint/no-explicit-any */

// backend/src/utils/fetch-metadata-for-messages.ts

export type EmailMetadata = {
    id: string;
    from: string;
    subject: string;
    date: string;
    internalDate?: string;
};

type Plan = "free" | "pro";

interface GmailMessage {
    id?: string;
    threadId?: string;
}

interface GmailGetResponse {
    id?: string;
    internalDate?: string;
    payload?: {
        headers?: Array<{ name?: string; value?: string }>;
    };
}

// ---- helpers ----

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGmailAuthError(err: any): boolean {
    if (!err) return false;

    const code = err?.code ?? err?.status;
    if (code === 401) return true;

    const payload = err?.error ?? err;

    if (payload?.status === "UNAUTHENTICATED") return true;

    if (Array.isArray(payload?.errors)) {
        if (payload.errors.some((e: any) => e.reason === "authError")) return true;
    }

    const msg = String(err?.message ?? "");
    if (msg.includes("Invalid Credentials") || msg.includes("invalid_grant")) return true;

    return false;
}

async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries = 5,
    baseDelay = 1000
): Promise<T> {
    let lastErr: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastErr = error;

            // If it’s an auth error, don’t retry here — let the worker refresh the token.
            if (isGmailAuthError(error)) {
                throw error;
            }

            const isRateLimitError =
                error?.code === 429 ||
                error?.status === 429 ||
                error?.error?.status === "RESOURCE_EXHAUSTED" ||
                (error?.code === 403 && String(error?.message || "").includes("Quota"));

            if (!isRateLimitError || attempt === maxRetries - 1) {
                throw error;
            }

            const delay = baseDelay * Math.pow(2, attempt);
            console.log(
                `Rate limited fetching Gmail metadata, retrying in ${delay}ms (attempt ${attempt + 1
                }/${maxRetries})`
            );
            await sleep(delay);
        }
    }

    throw lastErr ?? new Error("Max retries exceeded");
}

/**
 * Fetch metadata for multiple messages with controlled parallelism using raw fetch + access token.
 * This is called inside worker.ts via withTokenRefresh(accessToken -> this fn).
 */
export async function fetchMetadataForMessages(
    accessToken: string,
    messages: GmailMessage[],
    current_plan: Plan,
    onProgress?: (progress: {
        phase: "processing_metadata";
        messagesProcessed: number;
        totalMessages: number;
        percentage: number;
    }) => void
): Promise<EmailMetadata[]> {
    if (!messages || messages.length === 0) {
        console.log("No messages to process for metadata.");
        return [];
    }

    const BATCH_SIZE = 200;
    const BATCH_DELAY = 500;

    const results: EmailMetadata[] = [];
    const errors: string[] = [];

    const messageIds = messages
        .map((m) => m.id)
        .filter((id): id is string => !!id);

    console.log(
        `Processing ${messageIds.length} messages for metadata in batches of ${BATCH_SIZE}...`
    );

    const startTime = Date.now();

    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
        const batchIds = messageIds.slice(i, i + BATCH_SIZE);
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(messageIds.length / BATCH_SIZE);

        const batchStartTime = Date.now();
        console.log(
            `Metadata batch ${batchNumber}/${totalBatches} – ${batchIds.length} messages`
        );

        try {
            const batchResults = await getEmailMetadataBatch(accessToken, batchIds);
            results.push(...batchResults);
        } catch (err: any) {
            // If this is an auth error, bubble it up so worker can refresh token & retry the WHOLE call
            if (isGmailAuthError(err)) {
                console.error(
                    `Auth error in metadata batch ${batchNumber}:`,
                    err?.error || err?.message || err
                );
                throw err;
            }

            // Non-auth error: log + keep going
            console.error(
                `Non-auth error in metadata batch ${batchNumber}:`,
                err?.error || err?.message || err
            );
        }

        const batchDuration = ((Date.now() - batchStartTime) / 1000).toFixed(1);
        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);

        const percentage = Math.round((results.length / messageIds.length) * 100) || 0;
        const remainingMessages = messageIds.length - results.length;
        const estimatedRemaining =
            results.length > 0
                ? Math.ceil(
                    ((Date.now() - startTime) / results.length) * remainingMessages / 1000
                )
                : 0;

        console.log(
            `Batch ${batchNumber} done in ${batchDuration}s. ` +
            `Metadata progress: ${results.length}/${messageIds.length} (${percentage}%). ` +
            `Elapsed: ${totalDuration}s. ETA: ~${estimatedRemaining}s`
        );

        if (onProgress) {
            onProgress({
                phase: "processing_metadata",
                messagesProcessed: results.length,
                totalMessages: messageIds.length,
                percentage,
            });
        }

        if (i + BATCH_SIZE < messageIds.length) {
            await sleep(BATCH_DELAY);
        }
    }

    if (errors.length > 0) {
        console.warn(`Failed to fetch metadata for ${errors.length}/${messageIds.length} messages`);
    }

    console.log(
        `Completed processing ${results.length}/${messageIds.length} messages for metadata in ${(
            (Date.now() - startTime) /
            1000
        ).toFixed(1)}s`
    );

    return results;
}

/**
 * Fetch metadata for a batch of message IDs with concurrency and rate limiting.
 * Uses /gmail/v1/users/me/messages/{id}?format=metadata.
 */
async function getEmailMetadataBatch(
    accessToken: string,
    messageIds: string[]
): Promise<EmailMetadata[]> {
    if (messageIds.length === 0) return [];

    const results: EmailMetadata[] = [];
    const errors: string[] = [];

    const CONCURRENCY = 5;
    const DELAY_BETWEEN_REQUESTS = 50;

    let index = 0;

    async function worker(workerId: number) {
        while (index < messageIds.length) {
            const i = index++;
            const id = messageIds[i];

            try {
                const data = await retryWithBackoff(async () => {
                    const url = new URL(
                        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
                            id
                        )}`
                    );
                    url.searchParams.set("format", "metadata");
                    url.searchParams.append("metadataHeaders", "From");
                    url.searchParams.append("metadataHeaders", "Subject");
                    url.searchParams.append("metadataHeaders", "Date");

                    const res = await fetch(url.toString(), {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                        },
                    });

                    if (!res.ok) {
                        let body: any = null;
                        try {
                            body = await res.json();
                        } catch {
                            body = await res.text();
                        }

                        const err: any = new Error(
                            `Gmail metadata error for message ${id}: ${res.status}`
                        );
                        err.code = res.status;
                        err.error = body;
                        throw err;
                    }

                    return (await res.json()) as GmailGetResponse;
                });

                const headers = data.payload?.headers ?? [];

                results.push({
                    id: data.id ?? id,
                    from: headers.find((h) => h.name === "From")?.value?.toString() ?? "",
                    subject: headers.find((h) => h.name === "Subject")?.value?.toString() ?? "",
                    date: headers.find((h) => h.name === "Date")?.value?.toString() ?? "",
                    internalDate: data.internalDate
                        ? new Date(Number(data.internalDate)).toISOString()
                        : undefined,
                });

                await sleep(DELAY_BETWEEN_REQUESTS);
            } catch (err: any) {
                // Important: bubble up auth errors so worker.ts can refresh the token.
                if (isGmailAuthError(err)) {
                    console.error(
                        `Worker ${workerId} hit Gmail auth error on ${id}:`,
                        err?.error || err?.message || err
                    );
                    throw err;
                }

                errors.push(id);
                console.error(
                    `Worker ${workerId} failed to fetch ${id}:`,
                    err?.error || err?.message || err
                );
            }
        }
    }

    const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
    await Promise.all(workers);

    if (errors.length > 0) {
        console.warn(`Failed to fetch ${errors.length}/${messageIds.length} messages`);
    }

    return results;
}