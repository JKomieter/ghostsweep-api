// src/worker.ts
import { listEmails } from './utils/list-emails';
import { fetchMetadataForMessages } from './utils/fetch-metadata-for-messages';
import { summarizeByDomain } from './utils/summarize-by-domain';
import {
    recordSweepMetrics,
    getIncrementalScanDate,
} from './utils/cache';
import {
    isLikelySpam,
    normalizeServiceName,
    calculateConfidenceScore,
    categorizeService,
} from './utils/helpers';
import { encryptToken, decryptToken } from './utils/encryption';
import supabase from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { notify, sendEmail } from './utils/notify';
import { getUserEmail } from './utils/get-user';
import { getBreaches } from './utils/get-breaches';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const WORKER_POLL_INTERVAL = parseInt(process.env.WORKER_POLL_INTERVAL || '10000', 10);

// -----------------------------
// Auth / token helpers
// -----------------------------

function isGmailAuthError(err: any): boolean {
    if (!err) return false;

    // If the error has a top-level status/code
    const code = err?.code ?? err?.status;
    if (code === 401) return true;

    const payload = err?.error ?? err;

    if (payload?.status === 'UNAUTHENTICATED') return true;

    if (Array.isArray(payload?.errors)) {
        if (payload.errors.some((e: any) => e.reason === 'authError')) return true;
    }

    const msg = String(err?.message ?? '');
    if (msg.includes('Invalid Credentials') || msg.includes('invalid_grant')) return true;

    return false;
}

/**
 * Refresh Google OAuth access token
 */
async function refreshAccessToken(refreshToken: string): Promise<{
    access_token: string;
    expires_in: number;
}> {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        throw new Error('Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET');
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
    });

    if (!res.ok) {
        throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
    }

    return res.json();
}

/**
 * Ensure we have a valid access token before making Gmail calls.
 * If expired and we have a refresh token -> refresh & persist.
 */
async function ensureValidAccessToken(
    supabaseClient: SupabaseClient,
    gmailAccount: any
): Promise<string> {
    let accessToken = decryptToken(gmailAccount.access_token_encrypted);
    const refreshToken = gmailAccount.refresh_token_encrypted
        ? decryptToken(gmailAccount.refresh_token_encrypted)
        : null;

    const nowSec = Math.floor(Date.now() / 1000);

    const tokenExpirySec = gmailAccount.token_expires_at
        ? Math.floor(new Date(gmailAccount.token_expires_at as string).getTime() / 1000)
        : null;

    // If token is expired and refresh token is available, refresh proactively
    if (tokenExpirySec && tokenExpirySec < nowSec && refreshToken) {
        console.log('Access token expired. Refreshing before Gmail call...');
        const refreshed = await refreshAccessToken(refreshToken);
        accessToken = refreshed.access_token;

        const newExpiryIso = new Date(
            Date.now() + refreshed.expires_in * 1000
        ).toISOString();

        await supabaseClient
            .from('gmail_accounts')
            .update({
                access_token_encrypted: encryptToken(accessToken),
                token_expires_at: newExpiryIso,
                updated_at: new Date().toISOString(),
            })
            .eq('user_id', gmailAccount.user_id);
    }

    return accessToken;
}

/**
 * Wrap a Gmail operation to:
 *  - ensure valid access token
 *  - on auth error => refresh token + retry once
 */
async function withTokenRefresh<T>(
    supabaseClient: SupabaseClient,
    gmailAccount: any,
    fn: (accessToken: string) => Promise<T>
): Promise<T> {
    // First attempt with maybe-refreshed token
    let accessToken = await ensureValidAccessToken(supabaseClient, gmailAccount);

    try {
        return await fn(accessToken);
    } catch (err: any) {
        // If it wasn't an auth error, just rethrow
        if (!isGmailAuthError(err)) throw err;

        console.warn('Gmail auth error detected. Refreshing token and retrying once...');

        const refreshToken = gmailAccount.refresh_token_encrypted
            ? decryptToken(gmailAccount.refresh_token_encrypted)
            : null;

        if (!refreshToken) {
            console.error('No refresh token available; cannot recover from Gmail auth error.');
            throw err;
        }

        // Refresh token
        const refreshed = await refreshAccessToken(refreshToken);
        accessToken = refreshed.access_token;

        const newExpiryIso = new Date(
            Date.now() + refreshed.expires_in * 1000
        ).toISOString();

        await supabaseClient
            .from('gmail_accounts')
            .update({
                access_token_encrypted: encryptToken(accessToken),
                token_expires_at: newExpiryIso,
                updated_at: new Date().toISOString(),
            })
            .eq('user_id', gmailAccount.user_id);

        // Retry once with new token
        return await fn(accessToken);
    }
}

/**
 * Save sweep data to database
 */
async function saveSweepData(
    supabaseClient: SupabaseClient,
    data: {
        userId: string;
        email: string;
        summary: any[];
        breaches: any[];
        scanStartedAt: string;
        scanCompletedAt: string;
        totalAccountsFound: number;
        accountsSaved: number;
        isIncremental: boolean;
        messagesScanned: number;
    }
): Promise<void> {
    // Delete existing user_services for this user (fresh sweep)
    if (!data.isIncremental) {
        await supabaseClient.from('user_services').delete().eq('user_id', data.userId);
    }

    // Insert new services
    if (data.summary.length > 0) {
        const userServices = data.summary.map((s) => ({
            user_id: data.userId,
            service_id: s.serviceId,
            email_count: s.emailCount,
            first_seen_at: s.firstSeenAt,
            last_seen_at: s.lastSeenAt,
            confidence_score: s.confidence,
        }));

        const { error } = await supabaseClient.from('user_services').upsert(userServices);

        if (error) {
            console.error('Error saving user services:', error);
            throw error;
        }
    }

    // Handle breaches
    if (data.breaches.length > 0) {
        const userBreaches = data.breaches.map((b) => ({
            user_id: data.userId,
            breach_name: b.name,
            breach_date: b.breachDate,
            data_classes: b.dataClasses,
            description: b.description,
        }));

        await supabaseClient.from('user_breaches').upsert(userBreaches);
    }
}

/**
 * Process a single pending sweep job
 */
export async function processNextJob(): Promise<boolean> {
    try {
        // 1. Get oldest pending job
        const { data: job, error: jobErr } = await supabase
            .from('sweep_events')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (jobErr) throw jobErr;

        if (!job) {
            console.log('No pending jobs');
            return false;
        }

        const userId = job.user_id;
        const sweepEventId = job.id;

        console.log(`Processing sweep ${sweepEventId} for user ${userId}`);

        // Process the sweep
        await processSweep(supabase, userId, sweepEventId);

        return true;
    } catch (error) {
        console.error('Error in processNextJob:', error);
        return false;
    }
}

/**
 * Main sweep processing logic
 */
async function processSweep(
    supabaseClient: SupabaseClient,
    userId: string,
    sweepEventId: string
): Promise<void> {
    const scanStartedAt = Date.now();
    let currentPlan: 'free' | 'pro' | undefined = undefined;
    let gmailAddress: string | undefined = undefined;

    const user = await getUserEmail(userId);

    if (!user) {
        console.error("Couldn't get user");
        await notify(supabaseClient, {
            userId,
            type: 'sweep_failed',
            title: 'GhostSweep sweep failed',
            message: "We couldn't complete your latest sweep. Please try again, or reconnect Gmail.",
        });
        return;
    }

    try {
        console.log(`Starting sweep for event ${sweepEventId}`);

        // Update status to processing
        await supabaseClient
            .from('sweep_events')
            .update({
                status: 'processing',
                started_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', sweepEventId);

        // Get user subscription
        const { data: subscriptionData } = await supabaseClient
            .from('user_subscriptions')
            .select('current_plan')
            .eq('user_id', userId)
            .maybeSingle();

        currentPlan = (subscriptionData?.current_plan || 'free') as 'free' | 'pro';

        // Load Gmail connection
        const { data: gmailAccount, error: gmailErr } = await supabaseClient
            .from('gmail_accounts')
            .select(
                'user_id, gmail_address, access_token_encrypted, refresh_token_encrypted, token_expires_at'
            )
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .maybeSingle();

        if (gmailErr || !gmailAccount) {
            throw new Error('Gmail account not found');
        }

        gmailAddress = gmailAccount.gmail_address;

        // Get incremental scan date
        const lastScanDate = await getIncrementalScanDate(supabaseClient, userId, 24);
        const isIncremental = !!lastScanDate;

        console.log(
            isIncremental
                ? `Incremental scan since ${lastScanDate.toISOString()}`
                : `Full scan for ${currentPlan} user`
        );

        // Step 1: List Gmail messages (wrapped with token refresh)
        console.log('Step 1: Listing messages...');
        const messages = await withTokenRefresh(
            supabaseClient,
            gmailAccount,
            (accessToken) => listEmails(accessToken, currentPlan as 'free' | 'pro', lastScanDate)
        );
        console.log(`Found ${messages.length} messages`);

        // Step 2: Fetch metadata (also wrapped with token refresh)
        console.log('Step 2: Fetching metadata...');
        const metadataList = await withTokenRefresh(
            supabaseClient,
            gmailAccount,
            (accessToken) =>
                fetchMetadataForMessages(
                    accessToken,
                    messages,
                    currentPlan as 'free' | 'pro',
                    async (progress) => {
                        await supabaseClient
                            .from('sweep_events')
                            .update({ progress: progress.percentage })
                            .eq('id', sweepEventId);
                    }
                )
        );
        console.log(`Processed ${metadataList.length} email metadata items`);

        // Step 3: Summarize by domain
        console.log('Step 3: Analyzing domains...');
        const domainSummaries = await summarizeByDomain(supabaseClient, metadataList);

        const enrichedSummaries = domainSummaries.map((summary) => ({
            ...summary,
            confidence: calculateConfidenceScore(summary),
            normalizedName: normalizeServiceName(summary.domain),
            category: categorizeService(summary.domain, summary.subjects || []),
        }));

        const filteredSummaries = enrichedSummaries.filter(
            (summary) => !isLikelySpam(summary)
        );

        filteredSummaries.sort((a, b) => b.confidence - a.confidence);

        console.log(`Identified ${filteredSummaries.length} unique services`);

        // Step 4: Check for breaches
        console.log('Step 4: Checking for breaches...');
        const breaches = await getBreaches(gmailAccount.gmail_address);

        // Apply plan limits
        const isFreePlan = currentPlan !== 'pro';
        const totalAccountsFound = filteredSummaries.length;
        const accountsToSave = isFreePlan
            ? filteredSummaries.slice(0, 50)
            : filteredSummaries;

        console.log(
            `Saving ${accountsToSave.length}/${totalAccountsFound} accounts (${currentPlan} plan)`
        );

        // Save to database
        await saveSweepData(supabaseClient, {
            userId,
            email: gmailAccount.gmail_address,
            summary: accountsToSave,
            breaches: breaches || [],
            scanStartedAt: new Date(scanStartedAt).toISOString(),
            scanCompletedAt: new Date().toISOString(),
            totalAccountsFound,
            accountsSaved: accountsToSave.length,
            isIncremental,
            messagesScanned: messages.length,
        });

        // Record metrics
        await recordSweepMetrics(supabaseClient, userId, {
            duration: Date.now() - scanStartedAt,
            messagesScanned: messages.length,
            accountsFound: totalAccountsFound,
            breachesFound: breaches?.length || 0,
            isIncremental,
        });

        // Mark as completed
        await supabaseClient
            .from('sweep_events')
            .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                services_found: totalAccountsFound,
                breaches_found: breaches?.length || 0,
                updated_at: new Date().toISOString(),
            })
            .eq('id', sweepEventId);

        // Update last_sweep_at
        await supabaseClient
            .from('user_subscriptions')
            .update({ last_sweep_at: new Date().toISOString() })
            .eq('user_id', userId);

        // Notify user (fixed message)
        await notify(supabaseClient, {
            userId,
            type: 'sweep_completed',
            title: 'GhostSweep sweep completed',
            message:
                'Your inbox has been scanned and your dashboard has been updated with the latest accounts and breaches.',
            metadata: {
                services_found: totalAccountsFound,
                breaches_found: breaches?.length,
            },
        });

        const elapsedTimeMs = Date.now() - scanStartedAt;

        // email the user
        await sendEmail({
            to: user?.email,
            templateId: '5c7439e4-7831-437e-98fd-5d3c6bbf20a7',
            variables: {
                total_accounts: totalAccountsFound,
                breaches_found: breaches?.length || 0,
                plan_label: currentPlan,
                scan_duration_seconds: (elapsedTimeMs / 1000).toFixed(3),
                gmail_address: gmailAddress,
            },
        });

        console.log(`Sweep event ${sweepEventId} completed successfully`);
    } catch (err: any) {
        console.error(`Sweep event ${sweepEventId} failed:`, err);

        await supabaseClient
            .from('sweep_events')
            .update({
                status: 'failed',
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                error_message: JSON.stringify(err),
            })
            .eq('id', sweepEventId);

        await notify(supabaseClient, {
            userId,
            type: 'sweep_failed',
            title: 'GhostSweep sweep failed',
            message:
                'We couldn’t complete your latest sweep. This often happens if your Gmail connection expired. Please reconnect Gmail and try again.',
            metadata: { error: String(err) },
        });

        await sendEmail({
            to: user?.email,
            templateId: '2ffe31a7-325e-4f0b-9055-573dd1467899',
            variables: {
                gmail_address: gmailAddress ?? '',
                error_message:
                    'We couldn’t complete your latest sweep. This usually happens if your Gmail connection expired or Google temporarily blocked access. Please reconnect Gmail from your dashboard and try again.',
            },
        });
    }
}

/**
 * Start the worker loop
 */
export function startWorker(): void {
    console.log(`Worker started - polling every ${WORKER_POLL_INTERVAL / 1000}s`);

    // Process immediately on startup
    processNextJob();

    // Poll for jobs
    setInterval(async () => {
        await processNextJob();
    }, WORKER_POLL_INTERVAL);
}