// backend/src/sweep/helpers.ts

import { config } from "dotenv";
config()
const LOGO_DEV_PUBLISHABLE_KEY = process.env.LOGO_DEV_PUBLISHABLE_KEY;

interface Summary {
    domain?: string;
    subject?: string;
    subjects?: string[];
    from?: string;
    emailCount?: number;
}

/**
 * Service name normalization and branding
 */
export function normalizeServiceName(domain: string): string {
    if (!domain) return "Unknown Service";

    // Remove common email prefixes
    const cleaned = domain
        .replace(
            /^(www|noreply|no-reply|info|support|notifications|accounts|team|hello|mail|updates)\./,
            ""
        )
        .toLowerCase()
        .trim();

    // Known service mappings (add more as you discover them)
    const knownServices: Record<string, string> = {
        // Big Tech
        "amazon.com": "Amazon",
        "amazon.co.uk": "Amazon UK",
        "amazon.ca": "Amazon Canada",
        "amazon.de": "Amazon Germany",
        "google.com": "Google",
        "gmail.com": "Gmail",
        "apple.com": "Apple",
        "microsoft.com": "Microsoft",
        "facebook.com": "Facebook",
        "instagram.com": "Instagram",
        "meta.com": "Meta",

        // Social Media
        "twitter.com": "X (Twitter)",
        "x.com": "X (Twitter)",
        "linkedin.com": "LinkedIn",
        "tiktok.com": "TikTok",
        "snapchat.com": "Snapchat",
        "reddit.com": "Reddit",
        "pinterest.com": "Pinterest",
        "tumblr.com": "Tumblr",
        "discord.com": "Discord",

        // Streaming
        "netflix.com": "Netflix",
        "spotify.com": "Spotify",
        "hulu.com": "Hulu",
        "disneyplus.com": "Disney+",
        "hbomax.com": "HBO Max",
        "primevideo.com": "Prime Video",
        "youtube.com": "YouTube",
        "twitch.tv": "Twitch",
        "pandora.com": "Pandora",
        "applemusic.com": "Apple Music",

        // Productivity & Work
        "slack.com": "Slack",
        "notion.so": "Notion",
        "notion.com": "Notion",
        "dropbox.com": "Dropbox",
        "box.com": "Box",
        "evernote.com": "Evernote",
        "asana.com": "Asana",
        "trello.com": "Trello",
        "monday.com": "Monday.com",
        "atlassian.com": "Atlassian",
        "zoom.us": "Zoom",
        "github.com": "GitHub",
        "gitlab.com": "GitLab",
        "figma.com": "Figma",

        // E-commerce & Shopping
        "ebay.com": "eBay",
        "etsy.com": "Etsy",
        "shopify.com": "Shopify",
        "walmart.com": "Walmart",
        "target.com": "Target",
        "bestbuy.com": "Best Buy",
        "wayfair.com": "Wayfair",
        "wish.com": "Wish",
        "aliexpress.com": "AliExpress",

        // Financial
        "paypal.com": "PayPal",
        "venmo.com": "Venmo",
        "cashapp.com": "Cash App",
        "stripe.com": "Stripe",
        "square.com": "Square",
        "robinhood.com": "Robinhood",
        "coinbase.com": "Coinbase",

        // Travel
        "airbnb.com": "Airbnb",
        "booking.com": "Booking.com",
        "expedia.com": "Expedia",
        "hotels.com": "Hotels.com",
        "uber.com": "Uber",
        "lyft.com": "Lyft",

        // Food Delivery
        "doordash.com": "DoorDash",
        "ubereats.com": "Uber Eats",
        "grubhub.com": "Grubhub",
        "postmates.com": "Postmates",

        // Adobe
        "adobe.com": "Adobe",
        "behance.net": "Behance",

        // News & Media
        "medium.com": "Medium",
        "substack.com": "Substack",
        "nytimes.com": "New York Times",
        "wsj.com": "Wall Street Journal",

        // Gaming
        "steampowered.com": "Steam",
        "epicgames.com": "Epic Games",
        "playstation.com": "PlayStation",
        "xbox.com": "Xbox",
        "nintendo.com": "Nintendo",
        "roblox.com": "Roblox",

        // Health & Fitness
        "myfitnesspal.com": "MyFitnessPal",
        "strava.com": "Strava",
        "peloton.com": "Peloton",
        "headspace.com": "Headspace",
        "calm.com": "Calm",
    };

    // Check if we have a known mapping
    if (knownServices[cleaned]) {
        return knownServices[cleaned];
    }

    // Otherwise, try to extract and capitalize the brand name
    const parts = cleaned.split(".");
    const brandName = parts[0];

    return capitalize(brandName);
}

/**
 * Calculate confidence score for account detection
 * Higher score = more likely to be a real account
 */
export function calculateConfidenceScore(summary: Summary): number {
    let score = 0;

    const domain = (summary.domain || "").toLowerCase();
    const allSubjects = (summary.subjects || [summary.subject] || [])
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    const from = (summary.from || "").toLowerCase();

    // --- Subject Line Signals (Higher weight) ---

    // Very high confidence signals
    if (
        /account created|welcome to|registration successful|you're all set/.test(
            allSubjects
        )
    ) {
        score += 10;
    }

    // Email verification
    if (
        /verify your email|confirm your email|verify your account/.test(allSubjects)
    ) {
        score += 9;
    }

    // Security/Authentication
    if (
        /password reset|security alert|two-factor|2fa|verification code/.test(
            allSubjects
        )
    ) {
        score += 8;
    }

    // Transactional (strong signal)
    if (
        /receipt|order confirmation|invoice|payment received|purchase/.test(
            allSubjects
        )
    ) {
        score += 7;
    }

    // Subscription/Billing
    if (/subscription|trial started|billing|renewed/.test(allSubjects)) {
        score += 6;
    }

    // Account management
    if (/account closed|account deletion|reactivate/.test(allSubjects)) {
        score += 5;
    }

    // --- Sender Signals ---

    // Automated sender addresses (good signal)
    if (
        /noreply@|no-reply@|notifications@|accounts@/.test(from) ||
        /noreply|no-reply|notifications|accounts/.test(domain)
    ) {
        score += 4;
    }

    // Official company domains (not subdomains of email providers)
    if (!/(gmail|yahoo|hotmail|outlook|aol|icloud)\.com/.test(domain)) {
        score += 3;
    }

    // --- Email Volume (Indicates ongoing relationship) ---
    const emailCount = summary.emailCount || 0;

    if (emailCount >= 20) {
        score += 6; // Very active account
    } else if (emailCount >= 10) {
        score += 4; // Active account
    } else if (emailCount >= 5) {
        score += 2; // Moderate activity
    } else if (emailCount >= 2) {
        score += 1; // Some activity
    }
    // Single email accounts get 0 bonus (might be one-off)

    return score;
}

/**
 * Categorize service by type
 */
export function categorizeService(
    domain: string,
    subjects: string[]
): string {
    const d = domain.toLowerCase();
    const s = (subjects || []).join(" ").toLowerCase();

    // Social Media
    if (
        /facebook|instagram|twitter|tiktok|snapchat|linkedin|reddit|pinterest/.test(
            d
        )
    ) {
        return "Social Media";
    }

    // Streaming & Entertainment
    if (
        /netflix|spotify|hulu|disney|hbo|youtube|twitch|pandora|music/.test(d)
    ) {
        return "Streaming & Entertainment";
    }

    // Shopping & E-commerce
    if (
        /amazon|ebay|etsy|shopify|walmart|target|shop|store/.test(d) ||
        /order|purchase|shipped|delivered/.test(s)
    ) {
        return "Shopping & E-commerce";
    }

    // Financial & Payments
    if (
        /paypal|venmo|stripe|bank|cash|robinhood|coinbase|payment/.test(d)
    ) {
        return "Financial & Payments";
    }

    // Productivity & Work
    if (
        /slack|notion|dropbox|github|zoom|asana|trello|figma|docs/.test(d)
    ) {
        return "Productivity & Work";
    }

    // Travel & Transportation
    if (
        /airbnb|booking|expedia|uber|lyft|hotel|flight|travel/.test(d)
    ) {
        return "Travel & Transportation";
    }

    // Food & Delivery
    if (
        /doordash|ubereats|grubhub|postmates|food|delivery|restaurant/.test(
            d
        )
    ) {
        return "Food & Delivery";
    }

    // Gaming
    if (/steam|epic|playstation|xbox|nintendo|gaming|game/.test(d)) {
        return "Gaming";
    }

    // Health & Fitness
    if (/fitness|health|gym|peloton|strava|workout/.test(d)) {
        return "Health & Fitness";
    }

    // News & Media
    if (/news|medium|substack|times|post|journalism/.test(d)) {
        return "News & Media";
    }

    // Email & Communication
    if (/gmail|outlook|yahoo|mail|email/.test(d)) {
        return "Email & Communication";
    }

    // Default
    return "Other";
}

/**
 * Extract logo URL for known services
 */
export function getServiceLogoUrl(domain: string): string {
    const cleanDomain = domain
        .replace(
            /^(www|noreply|no-reply|info|support|notifications)\./,
            ""
        )
        .toLowerCase();

    // Use Logo.dev API (requires API key)
    return `https://img.logo.dev/${cleanDomain}?token=${LOGO_DEV_PUBLISHABLE_KEY}`;
}

/**
 * Determine if email is likely spam/noise vs real account
 */
export function isLikelySpam(summary: Summary): boolean {
    const domain = (summary.domain || "").toLowerCase();
    const allSubjects = (summary.subjects || [summary.subject] || [])
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

    // Spam indicators
    const spamPatterns = [
        /unsubscribe/i,
        /newsletter/i,
        /daily digest/i,
        /weekly summary/i,
        /promotional/i,
        /limited time offer/i,
        /act now/i,
        /click here/i,
    ];

    const spamDomains = ["mailchimp", "sendgrid", "constantcontact"];

    // Check patterns
    const hasSpamPattern = spamPatterns.some((p) => p.test(allSubjects));
    const hasSpamDomain = spamDomains.some((d) => domain.includes(d));

    return hasSpamPattern || hasSpamDomain;
}

/**
 * Helper: Capitalize first letter of string
 */
function capitalize(str: string): string {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format account count for display
 */
export function formatAccountCount(count: number): string {
    if (count >= 1000) {
        return `${(count / 1000).toFixed(1)}K+`;
    }
    return count.toString();
}

/**
 * Generate account summary text
 */
export function generateAccountSummary(
    totalAccounts: number,
    breachCount: number,
    plan: string
): string {
    const accountText = totalAccounts === 1 ? "account" : "accounts";
    const breachText = breachCount === 1 ? "breach" : "breaches";

    if (breachCount > 0) {
        return `Found ${totalAccounts} ${accountText}, ${breachCount} ${breachText} detected`;
    }

    return `Found ${totalAccounts} ${accountText}`;
}