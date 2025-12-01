import { config } from "dotenv";

config()

const HIBP_API_KEY = process.env.HIBP_API_KEY ?? "";
export async function getBreaches(email: string) {
    const response = await fetch(`https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`, {
        method: 'GET',
        headers: {
            'hibp-api-key': HIBP_API_KEY
        }
    });
    if (response.status === 404) {
        // No breaches found
        return [];
    }
    if (!response.ok) {
        console.error('Error fetching breaches:', response.statusText);
        // throw new Error(`Error fetching breaches: ${response.statusText}`);
        return []
    }
    const breaches = await response.json();
    return breaches || [];
}
