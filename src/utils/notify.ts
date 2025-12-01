import { SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config()
type Notification = {
    userId: string;
    type: "sweep_completed" | "sweep_failed";
    title: string;
    message: string;
    metadata?: Record<string, any>
}

export async function notify(
    supabase: SupabaseClient,
    input: Notification
) {
    const { userId, type, title, message, metadata } = input;

    const {error} = await supabase.from("user_notifications")
        .insert({
            user_id: userId,
            title,
            message,
            metadata,
            type
        })   

    if (error) throw error
}

export type SendEmailInput = {
    to: string | undefined;
    templateId: string;   // 👈 your Resend template
    variables?: Record<string, any>;
};

export async function sendEmail(input: SendEmailInput) {
    const { to, templateId, variables } = input;

    const apiKey = process.env.RESEND_API_KEY!;

    if (!apiKey) throw new Error("Missing RESEND_API_KEY");

    const payload = {
        to,
        template: {
            id: templateId,
            variables
        }
    };

    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const err = await res.text();
        console.error("Resend email error:", err);
        throw new Error(`Failed to send email: ${err}`);
    }

    return await res.json();
}