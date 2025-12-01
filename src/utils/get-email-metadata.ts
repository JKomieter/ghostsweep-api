// backend/src/sweep/get-email-metadata.ts

export interface EmailMetadata {
    id: string;
    from: string;
    subject: string;
    date: string;
    internalDate?: string;
}

interface GmailMessageResponse {
    id: string;
    internalDate?: string;
    payload?: {
        headers?: Array<{
            name: string;
            value: string;
        }>;
    };
}

interface CustomError extends Error {
    code?: number;
    status?: number;
}

function isAuthError(err: any): boolean {
    if (!err) return false;

    // Common shapes from Google APIs
    if (err.code === 401 || err.status === 401) return true;

    if (err.error?.status === "UNAUTHENTICATED") return true;

    if (Array.isArray(err.error?.errors)) {
        if (err.error.errors.some((e: any) => e.reason === "authError")) {
            return true;
        }
    }

    return false;
}

/**
 * Simple sleep helper
 */
async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff, tuned for Gmail rate limits
 */
async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 5,
    baseDelay: number = 1000
): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const customError = error as CustomError;
            const code = customError?.code ?? customError?.status;
            const message = customError?.message ?? "";

            const isRateLimitError =
                code === 429 ||
                (code === 403 &&
                    (message.includes("quotaExceeded") ||
                        message.includes("rateLimitExceeded") ||
                        message.includes("Quota exceeded")));

            if (!isRateLimitError || attempt === maxRetries - 1) {
                throw error;
            }

            const delay = baseDelay * Math.pow(2, attempt);
            console.log(
                `Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
            );
            await sleep(delay);
        }
    }
    throw new Error("Max retries exceeded");
}

/**
 * Fetch metadata for multiple messages with controlled parallelism
 * Uses native fetch (Node.js 18+) or node-fetch
 */
export async function getEmailMetadataBatch(
    accessToken: string,
    messageIds: string[]
): Promise<EmailMetadata[]> {
    if (messageIds.length === 0) return [];

    const results: EmailMetadata[] = [];
    const errors: string[] = [];

    // ⚡ OPTIMIZED SETTINGS
    const CONCURRENCY = 5; // 5 parallel workers
    const DELAY_BETWEEN_REQUESTS = 50; // 50ms between requests per worker

    let index = 0;

    /**
     * Fetch a single message's metadata
     */
    async function fetchSingleMessage(id: string): Promise<EmailMetadata> {
        const url = new URL(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`
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
            const text = await res.text();
            // Throw a structured error so retryWithBackoff can detect rate limits
            const err = new Error(text) as CustomError;
            err.code = res.status;
            err.status = res.status;
            err.message = text;
            throw err;
        }

        const data: GmailMessageResponse = await res.json();
        const headers = data.payload?.headers ?? [];

        const from =
            headers.find((h) => h.name === "From")?.value?.toString() ?? "";
        const subject =
            headers.find((h) => h.name === "Subject")?.value?.toString() ?? "";
        const date =
            headers.find((h) => h.name === "Date")?.value?.toString() ?? "";

        return {
            id: data.id ?? id,
            from,
            subject,
            date,
            internalDate: data.internalDate
                ? new Date(Number(data.internalDate)).toISOString()
                : undefined,
        };
    }

    /**
     * Worker function that processes messages from the shared queue
     */
    async function worker(workerId: number) {
        while (index < messageIds.length) {
            const i = index++;
            const id = messageIds[i];

            try {
                const res = await retryWithBackoff(() =>
                    fetch(
                        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
                        {
                            headers: {
                                Authorization: `Bearer ${accessToken}`,
                            },
                        }
                    ).then(async (r) => {
                        if (!r.ok) {
                            const json = await r.json().catch(() => null);
                            const err: any = new Error("Gmail get failed");
                            err.code = r.status;
                            err.error = json?.error;
                            throw err;
                        }
                        return r.json();
                    })
                );

                // ... push to results as before ...

                await sleep(DELAY_BETWEEN_REQUESTS);
            } catch (err: any) {
                if (isAuthError(err)) {
                    console.error(`Worker ${workerId} encountered auth error, aborting all workers`, err);
                    // Re-throw so the whole batch fails and the outer sweep can handle it
                    throw new Error("GMAIL_AUTH_ERROR");
                }

                errors.push(id);
                console.error(
                    `Worker ${workerId} failed to fetch ${id}:`,
                    err?.message || JSON.stringify(err)
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