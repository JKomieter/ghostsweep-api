// backend/src/sweep/extraction.ts

/**
 * Extract email address from "Name <email@domain.com>" or plain "email@domain.com" format
 */
export function extractEmailAddress(from: string): string | null {
    if (!from) return null;

    // handles "Name" <email@domain.com>
    const match = from.match(/<([^>]+)>/);
    if (match) return match[1].trim();

    // fallback: basic email-in-string detection
    const simple = from.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return simple ? simple[0].trim() : null;
}

// utils/domains.ts

// Prefixes we don't want to treat as the brand
const IGNORED_PREFIXES = [
    "www",
    "noreply",
    "no-reply",
    "info",
    "support",
    "notifications",
    "accounts",
    "team",
    "hello",
    "mail",
    "updates",
    "announce",
    "auth",
    "auths",
    "app",
];

// Common multi-part public suffixes
const MULTIPART_SUFFIXES = new Set([
    "co.uk",
    "com.au",
    "co.jp",
    "com.br",
    "com.gh",
    "com.ng",
    "co.za",
]);

// Aliases where the MAIL domain is not the brand domain
const ALIAS_EXACT: Record<string, string> = {
    "facebookmail.com": "facebook.com",
    "amazonses.com": "amazon.com",
    "reply.github.com": "github.com",
    "githubmail.com": "github.com",
    "mail.twitter.com": "twitter.com",
    "e.uber.com": "uber.com",
    "mail.netflix.com": "netflix.com",
};

// Aliases where any subdomain of this host should point to a brand
const ALIAS_SUFFIX: Record<string, string> = {
    "github.com": "github.com",
    "twitter.com": "twitter.com",
    "uber.com": "uber.com",
    "netflix.com": "netflix.com",
};

/**
 * Take a hostname like "announce.airtimetools.com" or "auths.allgoodhq.app"
 * and return a clean base domain like "airtimetools.com" / "allgoodhq.app".
 */
function toBaseDomain(host: string): string {
    let parts = host
        .toLowerCase()
        .trim()
        .split(".")
        .filter(Boolean);

    if (parts.length <= 1) return host;

    // Drop noisy prefixes at the start while we still have > 2 labels
    while (parts.length > 2 && IGNORED_PREFIXES.includes(parts[0])) {
        parts = parts.slice(1);
    }

    if (parts.length <= 2) {
        return parts.join(".");
    }

    const lastTwo = parts.slice(-2).join(".");
    const lastThree = parts.slice(-3).join(".");

    // Handle multi-part public suffixes like example.co.uk
    if (MULTIPART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
        return lastThree;
    }

    // Default: brand.tld
    return lastTwo;
}

/**
 * Extract a canonical domain from an email address, suitable for logo lookups.
 * Examples:
 *   "no-reply@announce.airtimetools.com" → "airtimetools.com"
 *   "alerts@facebookmail.com"          → "facebook.com"
 *   "notifications@mail.netflix.com"   → "netflix.com"
 */
export function extractDomain(email: string | null): string | null {
    if (!email) return null;

    // In case we accidentally get "Name <user@domain.com>"
    const angleMatch = email.match(/<(.+?)>/);
    const raw = angleMatch ? angleMatch[1] : email;

    const parts = raw.split("@");
    if (parts.length !== 2) return null;

    let host = parts[1].toLowerCase().trim();

    // Remove trailing '.' if any
    host = host.replace(/\.+$/, "");

    if (!host) return null;

    // Exact alias remap first
    if (ALIAS_EXACT[host]) {
        return ALIAS_EXACT[host];
    }

    // Compute base domain
    const base = toBaseDomain(host);

    // If the base matches any alias suffix mapping, use that
    for (const [suffix, canonical] of Object.entries(ALIAS_SUFFIX)) {
        if (base === suffix || base.endsWith(`.${suffix}`)) {
            return canonical;
        }
    }

    return base;
}

/**
 * Extract sender name from "Name <email@domain.com>" format
 */
export function extractName(from: string): string | null {
    if (!from) return null;

    // Match "Name" <email@domain.com> format
    const match = from.match(/^(.*?)\s*<[^>]+>$/);
    if (match) {
        const name = match[1].replace(/(^"|"$)/g, "").trim();
        return name || null;
    }

    // If no angle brackets, return the whole string if it doesn't look like an email
    if (!from.includes("@")) {
        const name = from.replace(/(^"|"$)/g, "").trim();
        return name || null;
    }

    // Fallback: try to extract from email domain
    const email = extractEmailAddress(from);
    if (email) {
        const domain = extractDomain(email);
        if (domain) {
            const parts = domain.split(".");
            const brandName = parts[0];
            return brandName.charAt(0).toUpperCase() + brandName.slice(1);
        }
    }

    return null;
}

/**
 * Normalize domain to standard format
 */
export function normalizeDomain(domain: string): string {
    if (!domain) return domain;

    const d = domain.toLowerCase().trim();

    // Handle common email service subdomains
    const patterns = [/^(mail|email|smtp|notifications?|noreply|no-reply)\./i];

    let normalized = d;
    for (const pattern of patterns) {
        normalized = normalized.replace(pattern, "");
    }

    // Keep only the last 2 parts for common TLDs
    const parts = normalized.split(".");
    if (parts.length > 2) {
        const tld = parts[parts.length - 1];
        const sld = parts[parts.length - 2];

        const twoPartTlds = ["co.uk", "com.au", "co.jp", "com.br", "co.in"];
        const lastTwo = `${sld}.${tld}`;

        if (twoPartTlds.includes(lastTwo)) {
            return parts.slice(-3).join(".");
        } else {
            return parts.slice(-2).join(".");
        }
    }

    return normalized;
}