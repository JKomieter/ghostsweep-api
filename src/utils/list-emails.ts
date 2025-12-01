// backend/src/sweep/list-emails.ts

type Plan = "free" | "pro";

interface GmailMessage {
    id?: string;
    threadId?: string;
    payload?: {
        headers?: Array<{ name?: string; value?: string }>;
    };
}

interface GmailListResponse {
    messages?: GmailMessage[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
}

/**
 * List Gmail messages (IDs only) for a user using an access token.
 * Uses native fetch (Node.js 18+) instead of googleapis.
 */
export async function listEmails(
    accessToken: string,
    current_plan: Plan = "free",
    lastScanDate?: Date | null
): Promise<GmailMessage[]> {
    const isPro = current_plan === "pro";

    // --- Configuration ---
    const YEARS = isPro ? 15 : 10;
    const PAGE_SIZE = 500; // listing IDs is cheap
    const MAX_PAGES = isPro ? 20 : 8;
    const MAX_MESSAGES = MAX_PAGES * PAGE_SIZE; // 10,000 for pro, 4,000 for free

    // --- Incremental Scan Support ---
    const dateFilter = lastScanDate
        ? `after:${Math.floor(lastScanDate.getTime() / 1000)}`
        : `newer_than:${YEARS}y`;

    console.log(
        lastScanDate
            ? `Incremental scan: emails after ${lastScanDate.toISOString()}`
            : `Full scan: last ${YEARS} years`
    );

    // --- Comprehensive Keywords (Organized by Category) ---

    // Account Creation & Onboarding
    const ONBOARDING = [
        `"account created"`,
        `"welcome to"`,
        `"thanks for signing up"`,
        `"registration successful"`,
        `"your account is ready"`,
        `"get started with"`,
        `"activate your account"`,
        `"you're all set"`,
        `"welcome aboard"`,
        `"onboarding"`,
    ];

    // Email Verification
    const VERIFICATION = [
        `"verify your email"`,
        `"confirm your email"`,
        `"verify your account"`,
        `"email confirmation"`,
        `"click to verify"`,
        `"confirm your address"`,
    ];

    // Security & Authentication
    const SECURITY = [
        `"password reset"`,
        `"reset your password"`,
        `"new device login"`,
        `"security alert"`,
        `"unusual activity"`,
        `"suspicious activity"`,
        `"two-factor"`,
        `"2fa"`,
        `"verification code"`,
        `"sign-in attempt"`,
    ];

    // Billing & Purchases
    const BILLING = [
        `"receipt for your"`,
        `"your receipt"`,
        `"order confirmation"`,
        `"purchase confirmation"`,
        `"your order"`,
        `"invoice"`,
        `"payment received"`,
        `"subscription renewed"`,
        `"subscription confirmed"`,
        `"billing update"`,
        `"trial started"`,
        `"free trial"`,
    ];

    // Privacy & Legal
    const PRIVACY = [
        `"privacy policy"`,
        `"terms of service"`,
        `"terms and conditions"`,
        `"data access request"`,
        `"GDPR"`,
        `"CCPA"`,
        `"your privacy"`,
    ];

    // Account Management
    const MANAGEMENT = [
        `"account closed"`,
        `"account deletion"`,
        `"account deactivated"`,
        `"reactivate your account"`,
        `"we miss you"`,
        `"come back"`,
        `"subscription cancelled"`,
    ];

    // Combine all keywords
    const ALL_KEYWORDS = [
        ...ONBOARDING,
        ...VERIFICATION,
        ...SECURITY,
        ...BILLING,
        ...PRIVACY,
        ...MANAGEMENT,
    ].join(" OR ");

    // --- Query Construction ---

    // Primary query: Comprehensive keyword search
    const KEYWORD_QUERY = `${dateFilter} (${ALL_KEYWORDS}) -category:promotions`;

    // Fallback query: Common sender patterns
    const SENDER_QUERY = `${dateFilter} (
      from:noreply OR from:no-reply OR from:noreply@ OR 
      from:notifications OR from:notifications@ OR
      from:accounts OR from:accounts@ OR
      from:support OR from:hello OR from:team OR
      subject:"verify" OR subject:"welcome" OR 
      subject:"account" OR subject:"receipt" OR
      subject:"order" OR subject:"confirm"
    ) -category:promotions -category:forums`;

    const FALLBACK_THRESHOLD = 50;

    /**
     * Fetches message IDs matching a query with pagination
     * Uses fetch + accessToken (no googleapis)
     */
    async function fetchMessageIds(query: string): Promise<GmailMessage[]> {
        const messages: GmailMessage[] = [];
        let nextPageToken: string | undefined;
        let pageCount = 0;

        while (messages.length < MAX_MESSAGES && pageCount < MAX_PAGES) {
            pageCount++;

            const remaining = MAX_MESSAGES - messages.length;
            const batchSize = Math.min(PAGE_SIZE, remaining);

            if (batchSize <= 0) break;

            const url = new URL(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages"
            );
            url.searchParams.set("q", query);
            url.searchParams.set("maxResults", String(batchSize));
            if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);
            url.searchParams.set("includeSpamTrash", "false");

            try {
                const res = await fetch(url.toString(), {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                    },
                });

                if (!res.ok) {
                    const text = await res.text();

                    // 🔴 Treat invalid credentials as a hard failure
                    if (
                        res.status === 401 ||
                        text.includes("Invalid Credentials") ||
                        text.includes("UNAUTHENTICATED")
                    ) {
                        console.error(
                            `Gmail auth error on page ${pageCount}: ${res.status} ${text}`
                        );
                        throw new Error("GMAIL_AUTH_INVALID");
                    }

                    // Other errors: also throw (don't silently continue)
                    console.error(
                        `Error fetching page ${pageCount}: ${res.status} ${text}`
                    );
                    throw new Error(`Gmail list failed: ${res.status} ${text}`);
                }

                const json: GmailListResponse = await res.json();
                const batch = json.messages ?? [];

                if (batch.length === 0) break;

                messages.push(...batch);
                console.log(
                    `Page ${pageCount}: Found ${batch.length} messages (total: ${messages.length})`
                );

                nextPageToken = json.nextPageToken;
                if (!nextPageToken) break;
            } catch (error) {
                // Bubble error up so caller can handle (e.g. mark sweep as failed)
                console.error(`Error fetching page ${pageCount}:`, error);
                throw error;
            }
        }

        return messages.slice(0, MAX_MESSAGES);
    }

    /**
     * Deduplicates messages by ID
     */
    function deduplicateMessages(messages: GmailMessage[]): GmailMessage[] {
        const seen = new Set<string>();
        return messages.filter((msg) => {
            if (!msg.id || seen.has(msg.id)) return false;
            seen.add(msg.id);
            return true;
        });
    }

    // --- Main Execution ---
    try {
        console.log(
            `Starting ${isPro ? "Pro" : "Free"} scan for last ${YEARS} years...`
        );

        // Step 1: Run comprehensive keyword search
        let messages = await fetchMessageIds(KEYWORD_QUERY);
        console.log(`Keyword search found ${messages.length} message IDs`);

        // Step 2: If results are insufficient, augment with sender-based search
        if (messages.length < FALLBACK_THRESHOLD) {
            console.log(
                `Low yield (${messages.length}), running sender-based fallback...`
            );
            const senderMessages = await fetchMessageIds(SENDER_QUERY);
            console.log(`Sender search found ${senderMessages.length} message IDs`);

            // Combine and deduplicate
            const combined = [...messages, ...senderMessages];
            messages = deduplicateMessages(combined);
            console.log(`Combined total: ${messages.length} unique message IDs`);
        }

        return messages;
    } catch (error) {
        console.error("Critical error in email scanning:", error);

        // Preserve sentinel error so the worker can distinguish Gmail auth failure
        if (error instanceof Error && error.message === "GMAIL_AUTH_INVALID") {
            throw error;
        }

        throw new Error(
            `Failed to scan inbox: ${error instanceof Error ? error.message : "Unknown error"
            }`
        );
    }
}

/**
 * Extract sender domain from a Gmail message
 * Expects a message with payload.headers like the Gmail REST API returns
 */
export function extractSenderDomain(message: GmailMessage): string | null {
    const fromHeader = message.payload?.headers?.find(
        (h) => h.name?.toLowerCase() === "from"
    );

    if (!fromHeader?.value) return null;

    const match =
        fromHeader.value.match(/<(.+?)>/) ||
        fromHeader.value.match(/([^\s]+@[^\s]+)/);

    if (!match || !match[1]) return null;

    const email = match[1];
    const domainMatch = email.match(/@(.+?)$/);

    return domainMatch ? domainMatch[1].toLowerCase() : null;
}

/**
 * Check if email is likely account-related
 * Additional filtering layer for better precision
 */
export function isLikelyAccountEmail(message: GmailMessage): boolean {
    const headers = message.payload?.headers || [];

    const subject =
        headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
    const from =
        headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";

    // Exclude common noise patterns
    const noisePatterns = [
        /newsletter/i,
        /digest/i,
        /daily briefing/i,
        /weekly summary/i,
    ];

    const isNoise = noisePatterns.some(
        (pattern) => pattern.test(subject) || pattern.test(from)
    );

    if (isNoise) return false;

    // Strong positive signals
    const accountSignals = [
        /account/i,
        /verify/i,
        /confirm/i,
        /welcome/i,
        /receipt/i,
        /order/i,
        /invoice/i,
        /password/i,
        /security alert/i,
        /noreply@/i,
    ];

    const hasSignal = accountSignals.some(
        (pattern) => pattern.test(subject) || pattern.test(from)
    );

    return hasSignal;
}