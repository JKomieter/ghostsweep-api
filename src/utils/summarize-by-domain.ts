// backend/src/sweep/summarize-by-domain.ts
import { SupabaseClient } from "@supabase/supabase-js";
import { extractEmailAddress, extractDomain, extractName } from "./extraction";
import { categorizeService, getServiceLogoUrl } from "./helpers";

export type DomainAggregate = {
    domain: string;
    emailCount: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    serviceId: string | null;
    subject: string;
    subjects: string[];
    supportEmail: string | null;
    privacyEmail: string | null;
    contactConfidence: "high" | "medium" | "low";
};

interface EmailMetadata {
    from: string;
    subject: string;
    date: string;
    internalDate?: string;
}

/**
 * Extract contact emails from actual email headers
 */
function extractContactEmails(fromAddresses: string[]): {
    support?: string;
    privacy?: string;
} {
    const emails = fromAddresses
        .map((addr) => extractEmailAddress(addr)?.toLowerCase())
        .filter((e): e is string => !!e);

    const support = emails.find((e) =>
        /support|help|contact|service|customer/i.test(e)
    );

    const privacy = emails.find((e) =>
        /privacy|dpo|data.?protection/i.test(e)
    );

    return { support, privacy };
}

/**
 * Generate common email patterns for a domain
 */
function generateContactEmails(domain: string): {
    support: string;
    privacy: string;
} {
    return {
        support: `support@${domain}`,
        privacy: `privacy@${domain}`,
    };
}

/**
 * Summarize email metadata by domain and get/create services
 */
export async function summarizeByDomain(
    supabase: SupabaseClient,
    metadataList: EmailMetadata[]
): Promise<DomainAggregate[]> {
    const map = new Map<string, {
        emailCount: number;
               firstSeenAt: string | null;
                lastSeenAt: string | null;
                serviceId: string | null;
                subject: string;
                subjects: string[];
                fromAddresses: string[];
    }>()
    const serviceIds = new Map<string, string>();

    // First pass: group by domain and collect data
    for (const meta of metadataList) {
        const email = extractEmailAddress(meta.from);
        const domain = extractDomain(email);
        if (!domain) continue;

        // prefer internalDate if present, fallback to header date
        const iso =
            meta.internalDate ||
            (meta.date ? new Date(meta.date).toISOString() : null);

        if (!map.has(domain)) {
            map.set(domain, {
                emailCount: 0,
                firstSeenAt: iso,
                lastSeenAt: iso,
                serviceId: null,
                subject: meta.subject || "",
                subjects: [],
                fromAddresses: [],
            });
        }

        const agg = map.get(domain)!;
        agg.emailCount += 1;

        // Collect all subjects
        if (meta.subject) {
            agg.subjects.push(meta.subject);
        }

        // Collect all from addresses
        if (meta.from) {
            agg.fromAddresses.push(meta.from);
        }

        if (iso) {
            if (!agg.firstSeenAt || iso < agg.firstSeenAt) {
                agg.firstSeenAt = iso;
            }
            if (!agg.lastSeenAt || iso > agg.lastSeenAt) {
                agg.lastSeenAt = iso;
            }
        }
    }

    // Second pass: get/create services with contact info
    const results: DomainAggregate[] = [];

    for (const [domain, data] of map.entries()) {
        let serviceId: string | null = null;

        // Check cache first
        if (serviceIds.has(domain)) {
            serviceId = serviceIds.get(domain)!;
        } else {
            // Get the service id with the domain
            const { data: service, error: servicesError } = await supabase
                .from("services")
                .select("id")
                .eq("domain", domain)
                .maybeSingle();

            if ((servicesError && servicesError.code === "PGRST116") || !service) {
                // Service doesn't exist - determine contact emails before creating
                const extracted = extractContactEmails(data.fromAddresses);
                const generated = generateContactEmails(domain);

                const supportEmail = extracted.support || generated.support;
                const privacyEmail = extracted.privacy || generated.privacy;
                const logoUrl = getServiceLogoUrl(domain);
                const category = categorizeService(domain, [])

                // Create new service directly (not via edge function)
                const { data: newService, error: createError } = await supabase
                    .from("services")
                    .insert({
                        domain,
                        name: extractName(data.fromAddresses[0] || "") || domain,
                        default_privacy_email: privacyEmail || supportEmail,
                        category,
                        is_breached: false,
                        logo_url: logoUrl
                    })
                    .select("id")
                    .single();

                if (createError || !newService) {
                    console.error("Error creating new service:", createError);
                    throw createError
                } else {
                    serviceId = newService.id;
                }
            } else if (servicesError) {
                console.error("Error fetching service:", servicesError);
                throw servicesError
            } else {
                serviceId = service.id;
            }

            // Cache serviceId for domain
            if (serviceId) {
                serviceIds.set(domain, serviceId);
            }
        }

        // Determine contact emails for response
        const extracted = extractContactEmails(data.fromAddresses);

        let supportEmail: string | null = null;
        let privacyEmail: string | null = null;
        let contactConfidence: "high" | "medium" | "low" = "low";

        if (extracted.support || extracted.privacy) {
            supportEmail = extracted.support || null;
            privacyEmail = extracted.privacy || null;
            contactConfidence = "high";
        } else {
            const generated = generateContactEmails(domain);
            supportEmail = generated.support;
            privacyEmail = generated.privacy;
            contactConfidence = "low";
        }

        results.push({
            domain,
            emailCount: data.emailCount,
            firstSeenAt: data.firstSeenAt,
            lastSeenAt: data.lastSeenAt,
            serviceId,
            subject: data.subject,
            subjects: data.subjects,
            supportEmail,
            privacyEmail,
            contactConfidence,
        });
    }

    return results;
}