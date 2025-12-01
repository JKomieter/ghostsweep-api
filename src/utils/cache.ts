// backend/src/sweep/cache.ts
import { SupabaseClient } from "@supabase/supabase-js";

interface CachedSweepResult {
    userId: string;
    scanDate: Date;
    totalAccounts: number;
    accounts: any[];
    breaches: any[];
    expiresAt: Date;
}

interface SweepPermission {
    allowed: boolean;
    reason?: string;
    nextAllowedAt?: Date;
}

interface SweepMetrics {
    duration: number;
    messagesScanned: number;
    accountsFound: number;
    breachesFound: number;
    isIncremental: boolean;
}

/**
 * Check if user has a valid cached sweep result
 */
export async function getCachedSweepResult(
    supabase: SupabaseClient,
    userId: string
): Promise<CachedSweepResult | null> {
    // Get most recent COMPLETED sweep
    const { data: sweep, error } = await supabase
        .from("sweep_events")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "completed") // Only get completed sweeps
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error || !sweep) {
        return null;
    }

    // Check if cache is still valid (24 hours for pro, not used for free)
    const scanDate = new Date(sweep.started_at);
    const now = new Date();
    const hoursSinceScan =
        (now.getTime() - scanDate.getTime()) / (1000 * 60 * 60);

    // Cache valid for 24 hours
    if (hoursSinceScan > 24) {
        return null;
    }

    // Fetch the actual sweep data
    const { data: services } = await supabase
        .from("user_services")
        .select("*")
        .eq("user_id", userId);

    const { data: breaches } = await supabase
        .from("user_breaches")
        .select("*")
        .eq("user_id", userId);

    return {
        userId,
        scanDate,
        totalAccounts: services?.length || 0,
        accounts: services || [],
        breaches: breaches || [],
        expiresAt: new Date(scanDate.getTime() + 24 * 60 * 60 * 1000),
    };
}

/**
 * Invalidate cached sweep results
 */
export async function invalidateSweepCache(
    supabase: SupabaseClient,
    userId: string
): Promise<void> {
    // Mark all previous sweeps as stale
    await supabase
        .from("sweep_events")
        .update({ is_stale: true })
        .eq("user_id", userId);
}

/**
 * Get incremental scan window
 * Returns the date from which to scan new emails
 */
export async function getIncrementalScanDate(
    supabase: SupabaseClient,
    userId: string,
    maxHoursOld: number = 24
): Promise<Date | null> {
    const { data: sweep } = await supabase
        .from("sweep_events")
        .select("started_at, status")
        .eq("user_id", userId)
        .eq("status", "completed") // Only consider completed sweeps
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!sweep?.started_at) {
        return null;
    }

    const scanDate = new Date(sweep.started_at);
    const now = new Date();
    const hoursSinceScan =
        (now.getTime() - scanDate.getTime()) / (1000 * 60 * 60);

    // Only use incremental if scan was recent
    if (hoursSinceScan > maxHoursOld) {
        return null;
    }

    return scanDate;
}

/**
 * Check if user can perform a new sweep (rate limiting)
 */
export async function canPerformSweep(
    supabase: SupabaseClient,
    userId: string,
    plan: "free" | "pro"
): Promise<SweepPermission> {
    // Check if there's already a sweep in progress
    const { data: activeSweep } = await supabase
        .from("sweep_events")
        .select("id, status")
        .eq("user_id", userId)
        .in("status", ["pending", "processing"])
        .maybeSingle();

    if (activeSweep) {
        return {
            allowed: false,
            reason: "A sweep is already in progress. Please wait for it to complete.",
        };
    }

    // Pro users: unlimited scans
    if (plan === "pro") {
        return {
            allowed: true,
        };
    }

    // Free users: 1 sweep per month
    const { data: subscription } = await supabase
        .from("user_subscriptions")
        .select("last_sweep_at")
        .eq("user_id", userId)
        .maybeSingle();

    if (!subscription?.last_sweep_at) {
        return {
            allowed: true,
        };
    }

    const lastSweep = new Date(subscription.last_sweep_at);
    const now = new Date();
    const sameMonth =
        lastSweep.getUTCFullYear() === now.getUTCFullYear() &&
        lastSweep.getUTCMonth() === now.getUTCMonth();

    if (sameMonth) {
        // Calculate next allowed date (first day of next month)
        const nextMonth = new Date(
            now.getUTCFullYear(),
            now.getUTCMonth() + 1,
            1
        );
        return {
            allowed: false,
            reason:
                "Monthly sweep limit reached. Upgrade to Professional for unlimited scans.",
            nextAllowedAt: nextMonth,
        };
    }

    return {
        allowed: true,
    };
}

/**
 * Record sweep performance metrics
 */
export async function recordSweepMetrics(
    supabase: SupabaseClient,
    userId: string,
    metrics: SweepMetrics
): Promise<void> {
    // Store in a metrics table for analytics
    const { error } = await supabase.from("sweep_metrics").insert({
        user_id: userId,
        duration_ms: metrics.duration,
        messages_scanned: metrics.messagesScanned,
        accounts_found: metrics.accountsFound,
        breaches_found: metrics.breachesFound,
        is_incremental: metrics.isIncremental,
        created_at: new Date().toISOString(),
    });

    if (error) {
        console.error("Error recording sweep metrics:", error);
    }

    console.log("Sweep metrics:", metrics);
}